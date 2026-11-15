// WhatsApp companion. The only listener is a mode-0600 Unix socket shared
// with the application; pairing codes and account contents are never logged.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

type service struct {
	mu sync.Mutex
	sendMu sync.Mutex
	client *whatsmeow.Client
	ledger *sql.DB
	qr string
	state string
}

func reply(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (s *service) status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet { reply(w, 405, map[string]string{"outcome":"not_sent"}); return }
	s.mu.Lock(); defer s.mu.Unlock()
	state := s.state
	if s.client.IsLoggedIn() && s.client.IsConnected() { state = "connected" }
	reply(w, 200, map[string]string{"status":state,"qr":s.qr})
}

func (s *service) pair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { reply(w, 405, map[string]string{"outcome":"not_sent"}); return }
	s.mu.Lock()
	if s.client.Store.ID != nil { s.mu.Unlock(); reply(w, 409, map[string]string{"outcome":"not_sent", "message":"Аккаунт уже привязан"}); return }
	if s.state == "waiting" || s.state == "connecting" { s.mu.Unlock(); reply(w, 200, map[string]string{"status":"waiting"}); return }
	s.state = "connecting"
	s.mu.Unlock()
	channel, err := s.client.GetQRChannel(context.Background())
	if err != nil { s.mu.Lock(); s.state="error"; s.mu.Unlock(); reply(w, 503, map[string]string{"outcome":"not_sent"}); return }
	if err = s.client.Connect(); err != nil { s.mu.Lock(); s.state="error"; s.mu.Unlock(); reply(w, 503, map[string]string{"outcome":"not_sent"}); return }
	go func() {
		for event := range channel {
			s.mu.Lock()
			switch event.Event {
			case "code": s.qr=event.Code; s.state="waiting"
			case "success": s.qr=""; s.state="connecting"
			default: s.qr=""; s.state="error"
			}
			s.mu.Unlock()
		}
	}()
	reply(w, 200, map[string]string{"status":"connecting"})
}

type publication struct { ID string `json:"id"`; MIME string `json:"mime"`; Data string `json:"data"`; Caption string `json:"caption"` }

// Revoke only an identified test status already confirmed by WhatsApp.
func (s *service) revokeTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { reply(w, 405, map[string]string{"outcome":"not_sent"}); return }
	s.sendMu.Lock(); defer s.sendMu.Unlock()
	var input struct { ID string `json:"id"` }
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input) != nil || !strings.HasPrefix(input.ID, "manual-connection-test:") || len(input.ID) > 128 { reply(w, 400, map[string]string{"outcome":"not_sent"}); return }
	var state, messageID string
	if err := s.ledger.QueryRow("SELECT state, message_id FROM attempts WHERE id = ?", input.ID).Scan(&state, &messageID); err != nil || state != "sent" || messageID == "" { reply(w, 404, map[string]string{"outcome":"not_sent"}); return }
	if !s.client.IsLoggedIn() || !s.client.IsConnected() { reply(w, 409, map[string]string{"outcome":"not_sent"}); return }
	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Second); defer cancel()
	_, err := s.client.SendMessage(ctx, types.StatusBroadcastJID, s.client.BuildRevoke(types.StatusBroadcastJID, types.EmptyJID, messageID))
	if err != nil { log.Printf("test status deletion not confirmed: error_type=%T deadline=%t", err, errors.Is(err, context.DeadlineExceeded)); reply(w, 502, map[string]string{"outcome":"unknown"}); return }
	reply(w, 200, map[string]string{"outcome":"revoked"})
}

// Called only after a user explicitly confirms the status is absent.
func (s *service) confirmNotSent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { reply(w, 405, map[string]string{"outcome":"not_sent"}); return }
	s.sendMu.Lock(); defer s.sendMu.Unlock()
	var input struct { ID string `json:"id"` }
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input) != nil || input.ID == "" || len(input.ID) > 128 { reply(w, 400, map[string]string{"outcome":"not_sent"}); return }
	var state string
	err := s.ledger.QueryRow("SELECT state FROM attempts WHERE id = ?", input.ID).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) { reply(w, 200, map[string]string{"outcome":"cleared"}); return }
	if err != nil { reply(w, 503, map[string]string{"outcome":"not_sent"}); return }
	if state != "sending" { reply(w, 409, map[string]string{"outcome":"not_sent", "message":"WhatsApp уже подтвердил отправку"}); return }
	if _, err = s.ledger.Exec("DELETE FROM attempts WHERE id = ? AND state = 'sending'", input.ID); err != nil { reply(w, 503, map[string]string{"outcome":"not_sent"}); return }
	reply(w, 200, map[string]string{"outcome":"cleared"})
}

func (s *service) publish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { reply(w, 405, map[string]string{"outcome":"not_sent"}); return }
	s.sendMu.Lock(); defer s.sendMu.Unlock()
	var p publication
	r.Body = http.MaxBytesReader(w, r.Body, 42*1024*1024)
	if json.NewDecoder(r.Body).Decode(&p) != nil || p.ID == "" || len(p.ID) > 128 || len(p.Caption) > 4096 { reply(w, 400, map[string]string{"outcome":"not_sent"}); return }
	data, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil || len(data) == 0 || len(data) > 30*1024*1024 || (p.MIME != "image/jpeg" && p.MIME != "video/mp4") { reply(w, 400, map[string]string{"outcome":"not_sent"}); return }
	if !s.client.IsLoggedIn() || !s.client.IsConnected() { reply(w, 409, map[string]string{"outcome":"not_sent", "message":"Подключите WhatsApp студии"}); return }
	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Second); defer cancel()
	// Refuse sending if the account's actual status privacy cannot be read.
	privacy, err := s.client.GetStatusPrivacy(ctx)
	if err != nil || len(privacy)==0 { reply(w, 409, map[string]string{"outcome":"not_sent", "message":"Не удалось проверить видимость статуса WhatsApp"}); return }
	if privacy[0].Type != types.StatusPrivacyTypeContacts && privacy[0].Type != types.StatusPrivacyTypeBlacklist && privacy[0].Type != types.StatusPrivacyTypeWhitelist { reply(w, 409, map[string]string{"outcome":"not_sent", "message":"Неизвестные настройки видимости статуса WhatsApp"}); return }
	var recipients []types.JID
	if privacy[0].Type != types.StatusPrivacyTypeWhitelist {
		contacts, err := s.client.Store.Contacts.GetAllContacts(ctx)
		found := false
		excluded := make(map[types.JID]struct{})
		if privacy[0].Type == types.StatusPrivacyTypeBlacklist { for _, jid := range privacy[0].List { excluded[jid] = struct{}{} } }
		if err == nil { for jid, contact := range contacts { if _, blocked := excluded[jid]; !blocked && contact.FullName != "" { found = true; break } } }
		if !found {
			// Only WhatsApp's saved contacts are eligible; push names from chats
			// may belong to strangers and must never expand status visibility.
			if s.client.FetchAppState(ctx, appstate.WAPatchCriticalUnblockLow, true, false) == nil {
				contacts, err = s.client.Store.Contacts.GetAllContacts(ctx)
				if err == nil { for jid, contact := range contacts { if _, blocked := excluded[jid]; !blocked && contact.FullName != "" { found = true; break } } }
			}
		}
		if !found { reply(w, 409, map[string]string{"outcome":"not_sent", "message":"Контакты WhatsApp ещё не синхронизированы"}); return }
		for jid, contact := range contacts { if _, blocked := excluded[jid]; !blocked && contact.FullName != "" { recipients = append(recipients, jid) } }
	} else if len(privacy[0].List)==0 { reply(w, 409, map[string]string{"outcome":"not_sent", "message":"В списке видимости статусов нет контактов"}); return
	} else { recipients = privacy[0].List }
	// Prime the device cache in bounded batches before sending. WhatsApp may
	// never answer one enormous lookup for thousands of status recipients.
	// Nothing has been published yet, so a failure here is safe to retry.
	for start := 0; start < len(recipients); start += 100 {
		end := start + 100; if end > len(recipients) { end = len(recipients) }
		if _, err := s.client.GetUserDevices(ctx, recipients[start:end]); err != nil {
			log.Printf("status recipient lookup failed: error_type=%T deadline=%t", err, errors.Is(err, context.DeadlineExceeded))
			reply(w, 503, map[string]string{"outcome":"not_sent", "message":"Не удалось подготовить получателей статуса WhatsApp"}); return
		}
	}
	var oldState, oldMessage string
	err = s.ledger.QueryRowContext(ctx, "SELECT state, message_id FROM attempts WHERE id = ?", p.ID).Scan(&oldState, &oldMessage)
	if err == nil {
		if oldState == "sent" { reply(w, 200, map[string]string{"outcome":"sent", "id":oldMessage}); return }
		reply(w, 409, map[string]string{"outcome":"unknown", "message":"Проверьте WhatsApp перед повтором"}); return
	} else if !errors.Is(err, sql.ErrNoRows) { reply(w, 503, map[string]string{"outcome":"not_sent"}); return }
	mediaType := whatsmeow.MediaImage
	if p.MIME == "video/mp4" { mediaType = whatsmeow.MediaVideo }
	u, err := s.client.Upload(ctx, data, mediaType)
	if err != nil { reply(w, 503, map[string]string{"outcome":"not_sent", "message":"Не удалось загрузить файл в WhatsApp"}); return }
	var msg *waE2E.Message
	if p.MIME == "image/jpeg" {
		msg = &waE2E.Message{ImageMessage: &waE2E.ImageMessage{URL:&u.URL, DirectPath:&u.DirectPath, MediaKey:u.MediaKey, FileEncSHA256:u.FileEncSHA256, FileSHA256:u.FileSHA256, FileLength:&u.FileLength, Mimetype:proto.String(p.MIME), Caption:proto.String(p.Caption)}}
	} else {
		msg = &waE2E.Message{VideoMessage: &waE2E.VideoMessage{URL:&u.URL, DirectPath:&u.DirectPath, MediaKey:u.MediaKey, FileEncSHA256:u.FileEncSHA256, FileSHA256:u.FileSHA256, FileLength:&u.FileLength, Mimetype:proto.String(p.MIME), Caption:proto.String(p.Caption)}}
	}
	hash := sha256.Sum256([]byte(p.ID)); messageID := "3EB0" + strings.ToUpper(hex.EncodeToString(hash[:9]))
	if _, err := s.ledger.ExecContext(ctx, "INSERT INTO attempts(id, state, message_id) VALUES (?, 'sending', ?)", p.ID, messageID); err != nil { reply(w, 503, map[string]string{"outcome":"not_sent"}); return }
	result, err := s.client.SendMessage(ctx, types.StatusBroadcastJID, msg, whatsmeow.SendRequestExtra{ID:messageID})
	if err != nil { log.Printf("status send not confirmed: error_type=%T deadline=%t cancelled=%t participants=%s devices=%s encrypt=%s send=%s response=%s", err, errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled), result.DebugTimings.GetParticipants, result.DebugTimings.GetDevices, result.DebugTimings.PeerEncrypt, result.DebugTimings.Send, result.DebugTimings.Resp); reply(w, 502, map[string]string{"outcome":"unknown", "message":"Проверьте WhatsApp перед повтором"}); return }
	if _, err := s.ledger.ExecContext(ctx, "UPDATE attempts SET state = 'sent', message_id = ? WHERE id = ?", result.ID, p.ID); err != nil { reply(w, 502, map[string]string{"outcome":"unknown"}); return }
	reply(w, 200, map[string]string{"outcome":"sent", "id":result.ID})
}

func main() {
	syscall.Umask(0077)
	dir := os.Getenv("VIOLETTA_WHATSAPP_DIR")
	if dir == "" { dir = "/data/app/integrations/whatsapp" }
	if err := os.MkdirAll(dir, 0700); err != nil { log.Fatal("cannot create storage") }
	if err := os.Chmod(dir, 0700); err != nil { log.Fatal("cannot secure storage") }
	db, err := sqlstore.New(context.Background(), "sqlite3", "file:"+filepath.Join(dir,"session.db")+"?_foreign_keys=on&_journal_mode=WAL&_synchronous=FULL&_busy_timeout=5000", nil)
	if err != nil { log.Fatal("cannot open storage") }
	device, err := db.GetFirstDevice(context.Background()); if err != nil { log.Fatal("cannot open device") }
	ledger, err := sql.Open("sqlite3", "file:"+filepath.Join(dir,"attempts.db")+"?_busy_timeout=5000")
	if err != nil { log.Fatal("cannot open attempt ledger") }
	if _, err := ledger.Exec("CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, state TEXT NOT NULL, message_id TEXT NOT NULL)"); err != nil { log.Fatal("cannot initialize attempt ledger") }
	s := &service{client:whatsmeow.NewClient(device,nil), ledger:ledger, state:"disconnected"}
	if device.ID != nil { if s.client.Connect() != nil { log.Print("WhatsApp reconnect failed") } }
	path := filepath.Join(dir,"bridge.sock")
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 { log.Fatal("bridge path is not a socket") }
		if conn, err := net.DialTimeout("unix",path,time.Second); err == nil { conn.Close(); log.Fatal("bridge already running") }
		if err := os.Remove(path); err != nil { log.Fatal("cannot replace stale socket") }
	} else if !errors.Is(err, os.ErrNotExist) { log.Fatal("cannot inspect socket") }
	listener, err := net.Listen("unix",path); if err != nil { log.Fatal("cannot create socket") }
	if os.Chmod(path,0600) != nil { log.Fatal("cannot secure socket") }
	mux := http.NewServeMux(); mux.HandleFunc("/status",s.status); mux.HandleFunc("/pair",s.pair); mux.HandleFunc("/publish",s.publish); mux.HandleFunc("/confirm-not-sent",s.confirmNotSent); mux.HandleFunc("/revoke-test",s.revokeTest)
	server := &http.Server{Handler:mux, ReadHeaderTimeout:5*time.Second, ErrorLog:log.New(io.Discard,"",0)}
	if err := server.Serve(listener); err != nil && !errors.Is(err,http.ErrServerClosed) { log.Fatal("bridge stopped") }
}
