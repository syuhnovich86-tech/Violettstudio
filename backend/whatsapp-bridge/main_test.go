package main

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConfirmNotSentProtectsConfirmedAttempts(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil { t.Fatal(err) }
	defer db.Close()
	_, err = db.Exec("CREATE TABLE attempts(id TEXT PRIMARY KEY, state TEXT NOT NULL, message_id TEXT NOT NULL)")
	if err != nil { t.Fatal(err) }
	_, err = db.Exec("INSERT INTO attempts VALUES ('uncertain', 'sending', 'a'), ('confirmed', 'sent', 'b')")
	if err != nil { t.Fatal(err) }
	s := &service{ledger: db}
	request := func(id string) int {
		w := httptest.NewRecorder()
		s.confirmNotSent(w, httptest.NewRequest(http.MethodPost, "/confirm-not-sent", strings.NewReader(`{"id":"`+id+`"}`)))
		return w.Code
	}
	if got := request("confirmed"); got != http.StatusConflict { t.Fatalf("confirmed: %d", got) }
	if got := request("uncertain"); got != http.StatusOK { t.Fatalf("uncertain: %d", got) }
	var count int
	if err := db.QueryRow("SELECT count(*) FROM attempts WHERE id='confirmed'").Scan(&count); err != nil || count != 1 { t.Fatalf("confirmed attempt lost: %d, %v", count, err) }
	if err := db.QueryRow("SELECT count(*) FROM attempts WHERE id='uncertain'").Scan(&count); err != nil || count != 0 { t.Fatalf("uncertain attempt not cleared: %d, %v", count, err) }
}
