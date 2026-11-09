import { FormEvent, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

type User = {
  id: string;
  display_name: string;
  login: string;
  role: "owner" | "admin" | "employee";
  is_active: boolean;
  can_create_shared_workspaces: boolean;
  can_create_private_workspaces: boolean;
  can_add_comments: boolean;
  can_upload_media: boolean;
  can_view_all_calendars: boolean;
  can_access_admin: boolean;
  can_access_chats: boolean;
  can_access_content: boolean;
  can_access_analytics: boolean;
};

type Session = { user: User; csrf_token: string };
type IntegrationProvider = { configured: boolean; fields: Record<string, string> };
type IntegrationStatus = {
  openai: IntegrationProvider;
  telegram: IntegrationProvider;
  max: IntegrationProvider;
  instagram: IntegrationProvider;
  vk: IntegrationProvider;
  threads: IntegrationProvider;
};
type StorageStats = {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  media_bytes: number;
  used_percent: number;
};
type Workspace = {
  id: string;
  display_name: string;
  kind: "studio" | "private";
  owner_id: string;
  role: User["role"];
  file_count: number;
  size_bytes: number;
};
type Media = {
  id: string;
  owner_id: string;
  owner_name: string;
  workspace_id: string;
  workspace_name: string;
  workspace_kind: Workspace["kind"];
  original_name: string;
  media_type: "image" | "video";
  mime_type: string;
  size_bytes: number;
  created_at: string;
  captured_at: string | null;
  location_country: string | null;
  location_city: string | null;
  location_key: string | null;
  can_delete: boolean;
  publication_allowed: boolean;
  content_marked: boolean;
  comment: string | null;
  batch_id: string | null;
  batch_comment: string | null;
};

type MediaFilterOptions = {
  years: number[];
  months: { year: number; month: number; count: number }[];
  places: { key: string; country: string | null; city: string | null; label: string }[];
  without_location_count: number;
};

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

type MediaBatch = {
  id: string;
  workspace_id: string;
  yclients_record_id: number | null;
  comment: string | null;
  created_at: string;
};
type CalendarUser = { user_id: string; display_name: string };
type Visit = {
  record_id: number;
  user_id: string | null;
  starts_at: string;
  client_name: string | null;
  services: string[];
  comment: string | null;
  media_count: number;
  staff_name: string | null;
};
type DiscussionSummary = {
  id: string;
  title: string;
  kind: "general" | "custom" | "batch";
  batch_id: string | null;
  client_name: string | null;
  member_ids: string[];
  unread_count: number;
  first_unread_message_id: string | null;
  last_message: string | null;
  updated_at: string;
  can_delete: boolean;
  mentioned_me: boolean;
  is_private: boolean;
};
type DiscussionParticipant = { id: string; display_name: string };
type DiscussionMedia = {
  media_id: string;
  media_type: "image" | "video";
  original_name: string;
  batch_id: string | null;
  thumbnail_url: string;
  preview_url: string;
};
type ContentLibraryMedia = {
  id: string;
  original_name: string;
  media_type: "image" | "video";
  thumbnail_url: string;
  comment: string | null;
  content_marked: boolean;
  workspace_id: string;
  workspace_name: string;
};
type ContentLibraryWorkspace = { id: string; display_name: string; kind: "studio" | "private" };
type ContentLibraryResult = { items: ContentLibraryMedia[]; workspaces: ContentLibraryWorkspace[]; total: number; next_offset: number | null };
type DiscussionMessageItem = {
  id: string;
  discussion_id: string;
  author_id: string | null;
  author_name: string;
  body: string | null;
  reply_to: { id: string; author_name: string; body: string | null } | null;
  batch_id: string | null;
  attachments: DiscussionMedia[];
  reactions: Record<string, number>;
  my_reactions: string[];
  like_count: number;
  liked_by_me: boolean;
  created_at: string;
};
type DiscussionNotification = {
  id: string;
  kind: string;
  discussion_id: string | null;
  message_id: string | null;
  actor_name: string | null;
  read: boolean;
  created_at: string;
};
type NotificationSummary = { unread_count: number; notifications: DiscussionNotification[] };
type ShareVideoStatus = {
  state: "not_started" | "pending" | "processing" | "ready" | "error";
  progress: number;
  size_bytes: number | null;
  error: string | null;
};
type ContentPlatform = "telegram" | "max" | "instagram" | "vk" | "threads";
type ContentFormat = "post" | "story" | "availability";
type ContentVisualStyle = "auto" | "light" | "dark";
type PublicationFormat = "post" | "story" | "reel";
type ContentStatus = "draft" | "review" | "approved" | "generating" | "ready" | "scheduled" | "published" | "failed";
type ContentPublication = {
  id: string;
  platform: ContentPlatform;
  publication_format: PublicationFormat;
  status: "pending" | "scheduled" | "publishing" | "published" | "failed";
  caption: string | null;
  media_ids: string[];
  external_id: string | null;
  error: string | null;
  published_at: string | null;
};
type ContentItem = {
  id: string;
  title: string;
  caption: string | null;
  editor_instruction: string | null;
  visual_edit_requested: boolean;
  visual_style: ContentVisualStyle;
  content_format: ContentFormat;
  media_limit: number;
  availability_staff_id: number | null;
  availability_slots: { staff_id: number; staff_name: string; date: string; times: string[] }[];
  status: ContentStatus;
  scheduled_at: string;
  publication_date_assigned: boolean;
  media_ids: string[];
  created_by_id: string;
  approved_by_id: string | null;
  approved_at: string | null;
  publications: ContentPublication[];
  created_at: string;
  updated_at: string;
};
type ContentArchiveEntry = { publication_id: string; title: string; description: string | null; platform: ContentPlatform; platforms?: ContentPlatform[]; published_at: string; preview_media_id: string | null };
type WeeklyContentEntry = {
  day: number;
  title: string;
  content_format: ContentFormat;
  visual_style: ContentVisualStyle;
  media_limit: number;
  platforms: ContentPlatform[];
  platform_formats: Partial<Record<ContentPlatform, PublicationFormat[]>>;
};
type AvailabilityStaff = { staff_id: number; staff_name: string; specialization: string | null };

const MEDIA_PAGE_SIZE = 40;

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(response.status === 401 ? "Неверный логин или пароль" : body.detail || "Не удалось выполнить действие");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function formatStorageSize(bytes: number) {
  const gigabytes = bytes / 1024 / 1024 / 1024;
  if (gigabytes >= 1) return `${gigabytes.toFixed(gigabytes >= 100 ? 0 : 1)} ГБ`;
  return `${Math.max(0, bytes / 1024 / 1024).toFixed(0)} МБ`;
}

function normalizeClientName(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
}

function StoragePanel() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadStorage() {
      try {
        setStats(await api<StorageStats>("/storage"));
        setError("");
      } catch {
        setError("Не удалось получить сведения о диске");
      }
    }
    const refresh = () => { void loadStorage(); };
    void loadStorage();
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("vita29:storage-changed", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("vita29:storage-changed", refresh);
    };
  }, []);

  const percent = Math.min(100, Math.max(0, stats?.used_percent ?? 0));
  return (
    <section className="storage-panel">
      <div className="storage-ring" style={{ background: `conic-gradient(var(--gold) ${percent}%, #eee5dc 0)` }} aria-label={`Диск заполнен на ${percent}%`}>
        <div><strong>{Math.round(percent)}%</strong><small>занято</small></div>
      </div>
      <div className="storage-content">
        <p className="eyebrow">Состояние диска</p>
        <h2>Хранилище</h2>
        {stats ? <>
          <div className="storage-facts">
            <span>Файлы студии<strong>{formatStorageSize(stats.media_bytes)}</strong></span>
            <span>Свободно<strong>{formatStorageSize(stats.free_bytes)} из {formatStorageSize(stats.total_bytes)}</strong></span>
          </div>
          <div className="storage-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${percent}%` }} /></div>
        </> : <p className="storage-loading">{error || "Считаем свободное место…"}</p>}
      </div>
    </section>
  );
}

function MediaPanel({
  session,
  onCreateChat,
  onCreateContent,
  mode,
}: {
  session: Session;
  onCreateChat: (file: Media) => void;
  onCreateContent: (files: Media[]) => void;
  mode: "add" | "browse";
}) {
  const [files, setFiles] = useState<Media[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState("");
  const [uploadWorkspace, setUploadWorkspace] = useState("");
  const [preview, setPreview] = useState<Media | null>(null);
  const [moving, setMoving] = useState<Media | null>(null);
  const [moveWorkspace, setMoveWorkspace] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [captureYear, setCaptureYear] = useState("");
  const [captureMonth, setCaptureMonth] = useState("");
  const [locationKey, setLocationKey] = useState("");
  const [privateFilterOptions, setPrivateFilterOptions] = useState<MediaFilterOptions>({ years: [], months: [], places: [], without_location_count: 0 });
  const [procedureSearch, setProcedureSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState("");
  const [calendarUsers, setCalendarUsers] = useState<CalendarUser[]>([]);
  const [calendarUser, setCalendarUser] = useState("");
  const [calendarAll, setCalendarAll] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [calendarClientSearch, setCalendarClientSearch] = useState("");
  const [visits, setVisits] = useState<Visit[]>([]);
  const [selectedVisitDate, setSelectedVisitDate] = useState("");
  const [selectedVisitId, setSelectedVisitId] = useState<number | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [publicationAllowed, setPublicationAllowed] = useState(true);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<"photo" | "video">("photo");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [capturedFiles, setCapturedFiles] = useState<File[]>([]);
  const [capturedVideo, setCapturedVideo] = useState<File | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [batchComment, setBatchComment] = useState("");
  const [commenting, setCommenting] = useState<Media | null>(null);
  const [mediaComment, setMediaComment] = useState("");
  const [commentParticipants, setCommentParticipants] = useState<DiscussionParticipant[]>([]);
  const [shareProgress, setShareProgress] = useState<Record<string, number>>({});
  const [browseClientSearch, setBrowseClientSearch] = useState("");
  const [browseVisitDate, setBrowseVisitDate] = useState("");
  const [browseVisitId, setBrowseVisitId] = useState<number | null>(null);
  const [browseAcrossWorkspaces, setBrowseAcrossWorkspaces] = useState(false);
  const [contentSelection, setContentSelection] = useState<string[]>([]);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const workspacePicker = useRef<HTMLDetailsElement | null>(null);
  const cameraVideo = useRef<HTMLVideoElement | null>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const recordedChunks = useRef<Blob[]>([]);
  const recordingTimer = useRef<number | null>(null);
  const preparedShareFiles = useRef(new Map<string, File>());
  const sharePreparations = useRef(new Map<string, Promise<File>>());
  const privateFilterRequest = useRef(0);
  const [privateFilterLoading, setPrivateFilterLoading] = useState(false);
  const activeWorkspaceStorageKey = `vita29-active-workspace:${session.user.id}`;
  const uploadWorkspaceStorageKey = `vita29-upload-workspace:${session.user.id}`;

  const previewIndex = preview ? files.findIndex((file) => file.id === preview.id) : -1;
  const activeWorkspaceInfo = workspaces.find((workspace) => workspace.id === activeWorkspace);
  const uploadWorkspaceInfo = workspaces.find((workspace) => workspace.id === uploadWorkspace);
  const privateWorkspaces = workspaces.filter((workspace) => workspace.kind === "private");
  const sharedWorkspaces = workspaces.filter((workspace) => workspace.kind === "studio");
  const [calendarYear, calendarMonthNumber] = calendarMonth.split("-").map(Number);
  const calendarDayCount = new Date(calendarYear, calendarMonthNumber, 0).getDate();
  const calendarOffset = (new Date(calendarYear, calendarMonthNumber - 1, 1).getDay() + 6) % 7;
  const clientSearchTokens = normalizeClientName(calendarClientSearch).split(/\s+/).filter(Boolean);
  const visibleVisits = clientSearchTokens.length === 0
    ? visits
    : visits.filter((visit) => {
      const clientName = normalizeClientName(visit.client_name ?? "");
      return clientSearchTokens.every((token) => clientName.includes(token));
    });
  const visitsByDate = visibleVisits.reduce<Record<string, Visit[]>>((groups, visit) => {
    const key = visit.starts_at.slice(0, 10);
    (groups[key] ??= []).push(visit);
    return groups;
  }, {});
  const browseClientTokens = normalizeClientName(browseClientSearch).split(/\s+/).filter(Boolean);
  const browseVisibleVisits =
    browseClientTokens.length === 0
      ? visits
      : visits.filter((visit) => {
          const clientName = normalizeClientName(visit.client_name ?? "");
          return browseClientTokens.every((token) => clientName.includes(token));
        });
  const browseVisitsByDate = browseVisibleVisits.reduce<Record<string, Visit[]>>((groups, visit) => {
    const key = visit.starts_at.slice(0, 10);
    (groups[key] ??= []).push(visit);
    return groups;
  }, {});
  const browseSelectedVisits = browseVisitsByDate[browseVisitDate] ?? [];
  const selectedVisits = visitsByDate[selectedVisitDate] ?? [];
  const availablePrivateMonths = captureYear
    ? (privateFilterOptions.months ?? []).filter((item) => item.year === Number(captureYear))
    : [];

  const canSwitchAllCalendars = (session.user.role === "owner" || session.user.can_view_all_calendars) && calendarUsers.length > 1;

  function showAdjacent(direction: -1 | 1) {
    const next = previewIndex + direction;
    if (next >= 0 && next < files.length) setPreview(files[next]);
  }

  function effectiveComment(file: Media) {
    return file.comment || file.batch_comment;
  }

  function videoIsPreparing(file: Media) {
    const progress = shareProgress[file.id] ?? 0;
    return file.media_type === "video" && progress > 0 && progress < 100;
  }

  function prepareVideoForShare(file: Media) {
    const prepared = preparedShareFiles.current.get(file.id);
    if (prepared) return Promise.resolve(prepared);
    const existing = sharePreparations.current.get(file.id);
    if (existing) return existing;

    setShareProgress((current) => ({ ...current, [file.id]: 1 }));
    const preparation = (async () => {
      let status = await api<ShareVideoStatus>(`/media/${file.id}/share/prepare`, {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      while (status.state !== "ready") {
        if (status.state === "error") {
          throw new Error("Не удалось преобразовать видео для Android");
        }
        const conversionProgress = Math.max(1, Math.min(85, Math.round(status.progress * 0.85)));
        setShareProgress((current) => ({ ...current, [file.id]: conversionProgress }));
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        status = await api<ShareVideoStatus>(`/media/${file.id}/share/status`);
      }

      setShareProgress((current) => ({ ...current, [file.id]: 86 }));
      return new Promise<File>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("GET", `/api/v1/media/${file.id}/share/download`);
        request.responseType = "blob";
        request.onprogress = (event) => {
          const downloadProgress = event.lengthComputable && event.total > 0
            ? Math.round((event.loaded / event.total) * 13)
            : 1;
          setShareProgress((current) => ({ ...current, [file.id]: Math.min(99, 86 + downloadProgress) }));
        };
        request.onload = () => {
          if (request.status < 200 || request.status >= 300) {
            reject(new Error("Не удалось загрузить подготовленное видео"));
            return;
          }
          const readyFile = new File(
            [request.response],
            `Violetta-video-${file.id.slice(0, 8)}.mp4`,
            { type: "video/mp4" },
          );
          preparedShareFiles.current.clear();
          preparedShareFiles.current.set(file.id, readyFile);
          setShareProgress((current) => ({ ...current, [file.id]: 100 }));
          resolve(readyFile);
        };
        request.onerror = () => reject(new Error("Не удалось загрузить подготовленное видео"));
        request.send();
      });
    })().catch((reason) => {
      setShareProgress((current) => {
        const next = { ...current };
        delete next[file.id];
        return next;
      });
      setMessage(reason instanceof Error ? reason.message : "Не удалось подготовить видео");
      throw reason;
    }).finally(() => {
      sharePreparations.current.delete(file.id);
    });
    sharePreparations.current.set(file.id, preparation);
    return preparation;
  }

  async function loadFiles(
    workspaceId: string | null = activeWorkspace,
    from = mode === "browse" ? dateFrom : "",
    to = mode === "browse" ? dateTo : "",
    procedure = mode === "browse" ? procedureSearch : "",
    client = mode === "browse" ? browseClientSearch : "",
    visitId = mode === "browse" ? browseVisitId : null,
    acrossWorkspaces = browseAcrossWorkspaces,
    calendarDay = "",
    year = mode === "browse" ? captureYear : "",
    place = mode === "browse" ? locationKey : "",
    month = mode === "browse" ? captureMonth : "",
  ) {
    const params = new URLSearchParams();
    if (!acrossWorkspaces && workspaceId) params.set("workspace_id", workspaceId);
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
    if (procedure.trim()) params.set("procedure", procedure.trim());
    if (client.trim()) params.set("client", client.trim());
    if (visitId !== null) params.set("yclients_record_id", String(visitId));
    if (calendarDay) params.set("calendar_date", calendarDay);
    if (!acrossWorkspaces && year) params.set("capture_year", year);
    if (!acrossWorkspaces && month) params.set("capture_month", month);
    if (!acrossWorkspaces && place) params.set("location_key", place);
    params.set("limit", String(MEDIA_PAGE_SIZE + 1));
    params.set("offset", "0");
    const page = await api<Media[]>(`/media?${params.toString()}`);
    setFiles(page.slice(0, MEDIA_PAGE_SIZE));
    setHasMore(page.length > MEDIA_PAGE_SIZE);
  }

  async function loadMore() {
    setLoadingMore(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ limit: String(MEDIA_PAGE_SIZE + 1), offset: String(files.length) });
      if (!browseAcrossWorkspaces) params.set("workspace_id", activeWorkspace);
      if (mode === "browse" && browseVisitDate && browseVisitId === null) {
        params.set("calendar_date", browseVisitDate);
      } else {
        if (mode === "browse" && dateFrom) params.set("date_from", dateFrom);
        if (mode === "browse" && dateTo) params.set("date_to", dateTo);
      }
      if (mode === "browse" && procedureSearch.trim()) params.set("procedure", procedureSearch.trim());
      if (mode === "browse" && browseClientSearch.trim()) {
        params.set("client", browseClientSearch.trim());
      }
      if (mode === "browse" && browseVisitId !== null) {
        params.set("yclients_record_id", String(browseVisitId));
      }
      if (!browseAcrossWorkspaces && captureYear) params.set("capture_year", captureYear);
      if (!browseAcrossWorkspaces && captureMonth) params.set("capture_month", captureMonth);
      if (!browseAcrossWorkspaces && locationKey) params.set("location_key", locationKey);
      const page = await api<Media[]>(`/media?${params.toString()}`);
      setFiles((current) => [...current, ...page.slice(0, MEDIA_PAGE_SIZE)]);
      setHasMore(page.length > MEDIA_PAGE_SIZE);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось показать следующие фото");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void api<Workspace[]>("/workspaces")
      .then(async (spaces) => {
        const defaultWorkspace =
          spaces.find(
            (space) => space.kind === "studio" && space.owner_id === session.user.id,
          )?.id ?? spaces[0]?.id;
        const savedWorkspace = localStorage.getItem(activeWorkspaceStorageKey);
        const savedUploadWorkspace = localStorage.getItem(uploadWorkspaceStorageKey);
        const initialWorkspace = spaces.some((space) => space.id === savedWorkspace)
          ? savedWorkspace!
          : defaultWorkspace;
        const initialUploadWorkspace = spaces.some((space) => space.id === savedUploadWorkspace)
          ? savedUploadWorkspace!
          : initialWorkspace;
        setWorkspaces(spaces);
        if (!initialWorkspace) return;
        setActiveWorkspace(initialWorkspace);
        setUploadWorkspace(initialUploadWorkspace);
        await loadFiles(initialWorkspace, "", "");
      })
      .catch(() => setMessage("Не удалось загрузить папки и файлы"));
  }, [session.user.id]);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void api<Workspace[]>("/workspaces").then((spaces) => {
        if (!mounted) return;
        setWorkspaces(spaces);
        const fallback = spaces.find((space) => space.kind === "studio" && space.owner_id === session.user.id)?.id ?? spaces[0]?.id ?? "";
        if (activeWorkspace && !spaces.some((space) => space.id === activeWorkspace)) {
          setFiles([]);
          setActiveWorkspace(fallback);
          if (fallback) void loadFiles(fallback, "", "");
        }
        if (uploadWorkspace && !spaces.some((space) => space.id === uploadWorkspace)) setUploadWorkspace(fallback);
      }).catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("violetta-users-changed", refresh);
    return () => { mounted = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("violetta-users-changed", refresh); };
  }, [session.user.id, activeWorkspace, uploadWorkspace]);

  useEffect(() => {
    const workspace = workspaces.find((item) => item.id === activeWorkspace);
    if (!workspace || workspace.kind !== "private") {
      setPrivateFilterOptions({ years: [], months: [], places: [], without_location_count: 0 });
      return;
    }
    const params = new URLSearchParams({ workspace_id: workspace.id });
    if (captureYear) params.set("capture_year", captureYear);
    if (captureMonth) params.set("capture_month", captureMonth);
    void api<MediaFilterOptions>(`/media/filter-options?${params.toString()}`)
      .then(setPrivateFilterOptions)
      .catch(() => setMessage("Не удалось загрузить годы и места съёмки"));
  }, [activeWorkspace, workspaces, captureYear, captureMonth]);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void api<CalendarUser[]>("/yclients/calendar-users").then((users) => {
        if (!mounted) return;
        setCalendarUsers(users);
        setCalendarUser((current) => users.some((item) => item.user_id === current) ? current : (users.find((item) => item.user_id === session.user.id)?.user_id ?? users[0]?.user_id ?? ""));
        if (calendarMonth && (calendarAll || users.some((item) => item.user_id === calendarUser))) void loadCalendarVisits(calendarAll ? null : calendarUser, calendarMonth).catch(() => undefined);
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("violetta-users-changed", refresh);
    return () => { mounted = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("violetta-users-changed", refresh); };
  }, [session.user.id, calendarUser, calendarAll, calendarMonth]);

  useEffect(() => {
    if (!calendarUser || !calendarMonth) return;
    setCalendarLoading(true);
    setSelectedVisitDate("");
    setSelectedVisitId(null);
    setBrowseVisitDate("");
    setBrowseVisitId(null);
    void loadCalendarVisits(calendarAll ? null : calendarUser, calendarMonth)
      .catch(() => setMessage("Не удалось загрузить календарь визитов"))
      .finally(() => setCalendarLoading(false));
  }, [calendarMonth, calendarUser, calendarAll]);

  useEffect(() => {
    setSelectedVisitDate("");
    setSelectedVisitId(null);
  }, [calendarClientSearch]);

  async function loadCalendarVisits(
    userId: string | null = calendarAll ? null : calendarUser,
    monthValue = calendarMonth,
  ) {
    if (!monthValue || (!calendarAll && !userId)) return;
    const [year, month] = monthValue.split("-").map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    const params = new URLSearchParams({
      start_date: `${monthValue}-01`,
      end_date: `${monthValue}-${String(lastDay).padStart(2, "0")}`,
    });
    if (userId) params.set("user_id", userId);
    setVisits(await api<Visit[]>(`/yclients/visits?${params.toString()}`));
  }

  useEffect(() => {
    if (!preview) return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPreview(null);
      if (event.key === "ArrowLeft" && previewIndex > 0) {
        setPreview(files[previewIndex - 1]);
      }
      if (event.key === "ArrowRight" && previewIndex < files.length - 1) {
        setPreview(files[previewIndex + 1]);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [files, preview, previewIndex]);

  useEffect(() => {
    if (!cameraOpen) return undefined;
    let cancelled = false;
    setCameraReady(false);
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Браузер не разрешает съёмку внутри приложения. Используйте запасную кнопку камеры.");
      return undefined;
    }
    void navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: cameraMode === "video" ? {
        echoCancellation: true,
        noiseSuppression: true,
      } : false,
    }).then((stream) => {
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStream.current = stream;
      if (cameraVideo.current) {
        cameraVideo.current.srcObject = stream;
        void cameraVideo.current.play().then(() => setCameraReady(true));
      }
    }).catch(() => setCameraError(
      cameraMode === "video"
        ? "Не удалось открыть камеру или микрофон. Разрешите доступ к ним в настройках браузера."
        : "Не удалось открыть камеру. Разрешите доступ к камере в настройках браузера.",
    ));
    return () => {
      cancelled = true;
      cameraStream.current?.getTracks().forEach((track) => track.stop());
      cameraStream.current = null;
    };
  }, [cameraOpen, cameraMode]);

  async function chooseWorkspace(workspaceId: string) {
    workspacePicker.current?.removeAttribute("open");
    setActiveWorkspace(workspaceId);
    setUploadWorkspace(workspaceId);
    localStorage.setItem(activeWorkspaceStorageKey, workspaceId);
    localStorage.setItem(uploadWorkspaceStorageKey, workspaceId);
    if (workspaces.find((workspace) => workspace.id === workspaceId)?.kind === "private") {
      setPublicationAllowed(true);
      setSelectedVisitId(null);
    }
    setDateFrom("");
    setDateTo("");
    setCaptureYear("");
    setCaptureMonth("");
    setLocationKey("");
    setProcedureSearch("");
    setBrowseClientSearch("");
    setBrowseVisitDate("");
    setBrowseVisitId(null);
    setPreview(null);
    setMessage("");
    setBrowseAcrossWorkspaces(false);
    try {
      await loadFiles(workspaceId, "", "", "", "", null, false, "", "", "");
    } catch {
      setMessage("Не удалось открыть папку");
    }
  }

  async function applyDateFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreview(null);
    setMessage("");
    try {
      await loadFiles();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось применить даты");
    }
  }

  async function applyPrivateArchiveFilter(year: string, month: string, place: string) {
    const requestId = ++privateFilterRequest.current;
    setCaptureYear(year);
    setCaptureMonth(month);
    setLocationKey(place);
    setPreview(null);
    setMessage("");
    setPrivateFilterLoading(true);
    try {
      const params = new URLSearchParams({
        workspace_id: activeWorkspace,
        limit: String(MEDIA_PAGE_SIZE + 1),
        offset: "0",
      });
      if (year) params.set("capture_year", year);
      if (month) params.set("capture_month", month);
      if (place) params.set("location_key", place);
      const page = await api<Media[]>(`/media?${params.toString()}`);
      if (requestId !== privateFilterRequest.current) return;
      setFiles(page.slice(0, MEDIA_PAGE_SIZE));
      setHasMore(page.length > MEDIA_PAGE_SIZE);
    } catch (reason) {
      if (requestId !== privateFilterRequest.current) return;
      setMessage(reason instanceof Error ? reason.message : "Не удалось обновить медиатеку");
    } finally {
      if (requestId === privateFilterRequest.current) setPrivateFilterLoading(false);
    }
  }

  async function clearDateFilter() {
    setDateFrom("");
    setDateTo("");
    setCaptureYear("");
    setCaptureMonth("");
    setLocationKey("");
    setProcedureSearch("");
    setBrowseClientSearch("");
    setBrowseVisitDate("");
    setBrowseVisitId(null);
    setPreview(null);
    setMessage("");
    setBrowseAcrossWorkspaces(false);
    try {
      await loadFiles(activeWorkspace, "", "", "", "", null, false, "", "", "");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось сбросить даты");
    }
  }

  async function selectBrowseDay(day: string) {
    setBrowseVisitDate(day);
    setBrowseVisitId(null);
    setDateFrom(day);
    setDateTo(day);
    setPreview(null);
    setMessage("");
    setBrowseAcrossWorkspaces(true);
    try {
      await loadFiles(null, "", "", procedureSearch, browseClientSearch, null, true, day);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось открыть материалы за день");
    }
  }

  async function selectBrowseVisit(visitId: number) {
    setBrowseVisitId(visitId);
    setDateFrom("");
    setDateTo("");
    setPreview(null);
    setMessage("");
    setBrowseAcrossWorkspaces(true);
    try {
      await loadFiles(null, "", "", procedureSearch, browseClientSearch, visitId, true);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось открыть материалы визита");
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setCreatingFolder(true);
    setMessage("");
    try {
      const workspace = await api<Workspace>("/workspaces", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({
          display_name: form.get("display_name"),
          kind: form.get("kind"),
        }),
      });
      setWorkspaces(await api<Workspace[]>("/workspaces"));
      setActiveWorkspace(workspace.id);
      setUploadWorkspace(workspace.id);
      setFiles([]);
      setHasMore(false);
      setPreview(null);
      formElement.reset();
      setMessage(`Папка «${workspace.display_name}» создана`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось создать папку");
    } finally {
      setCreatingFolder(false);
    }
  }

  async function upload(
selected: FileList | File[] | null,
batchId: string | null = null,
): Promise<boolean> {
    if (!selected?.length) return false;
    const selectedFiles = Array.from(selected);
    setBusy(true);
    setMessage("");
    try {
      let completed = 0;
      for (const file of selectedFiles) {
        const params = new URLSearchParams({
          workspace_id: uploadWorkspace,
          publication_allowed: String(publicationAllowed),
        });
        if (selectedVisitId !== null) params.set("yclients_record_id", String(selectedVisitId));
        if (batchId) params.set("batch_id", batchId);
        await uploadOneFile(file, params, completed, selectedFiles.length);
        completed += 1;
        setMessage(`Загружено ${completed} из ${selectedFiles.length}`);
      }
      await loadFiles();
      setWorkspaces(await api<Workspace[]>("/workspaces"));
      await loadCalendarVisits();
      window.dispatchEvent(new Event("vita29:storage-changed"));
      return true;
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Ошибка загрузки");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function uploadOneFile(
    file: File,
    params: URLSearchParams,
    completed: number,
    total: number,
  ): Promise<Media> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `/api/v1/media?${params.toString()}`);
      request.setRequestHeader("X-CSRF-Token", session.csrf_token);
      request.responseType = "json";
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
        const type = file.type.startsWith("video/") ? "видео" : "файл";
        setMessage(`Загружаем ${type} ${completed + 1} из ${total}: ${percent}%`);
      };
      request.onerror = () => reject(new Error("Соединение прервалось во время загрузки"));
      request.onabort = () => reject(new Error("Загрузка отменена"));
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          resolve(request.response as Media);
          return;
        }
        const detail = request.response?.detail;
        reject(new Error(typeof detail === "string" ? detail : "Не удалось загрузить файл"));
      };
      const body = new FormData();
      body.append("upload", file);
      request.send(body);
    });
  }

  function stageFiles(selected: FileList | File[] | null) {
  if (!selected?.length) return;
  setPendingFiles(Array.from(selected));
  setBatchComment("");
  setMessage("");
}

function cancelPendingBatch() {
  setPendingFiles([]);
  setBatchComment("");
}

async function savePendingBatch() {
  if (pendingFiles.length === 0 || !uploadWorkspace) return;

  setBusy(true);
  setMessage("");

  try {
    const batch = await api<MediaBatch>("/media/batches", {
      method: "POST",
      headers: { "X-CSRF-Token": session.csrf_token },
      body: JSON.stringify({
        workspace_id: uploadWorkspace,
        yclients_record_id: selectedVisitId,
        comment: batchComment.trim() || null,
      }),
    });

    let completed = 0;

    for (const file of pendingFiles) {
      const params = new URLSearchParams({
        workspace_id: uploadWorkspace,
        publication_allowed: String(publicationAllowed),
        batch_id: batch.id,
      });

      if (selectedVisitId !== null) {
        params.set("yclients_record_id", String(selectedVisitId));
      }

      await uploadOneFile(file, params, completed, pendingFiles.length);

      completed += 1;
      setMessage(`Сохраняем ${completed} из ${pendingFiles.length}`);
    }

    const savedCount = pendingFiles.length;

    setPendingFiles([]);
    setBatchComment("");

    await loadFiles();
    setWorkspaces(await api<Workspace[]>("/workspaces"));
    await loadCalendarVisits();
    window.dispatchEvent(new Event("vita29"));

    setMessage(`Сохранено файлов: ${savedCount}`);
  } catch (reason) {
    setMessage(
      reason instanceof Error
        ? reason.message
        : "Не удалось сохранить серию",
    );
  } finally {
    setBusy(false);
  }
}

function closeCamera() {
    if (mediaRecorder.current?.state === "recording") {
      mediaRecorder.current.ondataavailable = null;
      mediaRecorder.current.onstop = null;
      mediaRecorder.current.stop();
    }
    mediaRecorder.current = null;
    recordedChunks.current = [];
    if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
    recordingTimer.current = null;
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current = null;
    setCameraOpen(false);
    setCameraReady(false);
    setCameraError("");
    setCapturedFiles([]);
    setCapturedVideo(null);
    setRecording(false);
    setRecordingSeconds(0);
  }

  function recordingMimeType() {
    if (!("MediaRecorder" in window)) return "";
    const candidates = [
      "video/mp4;codecs=h264,aac",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
  }

  function startVideoRecording() {
    const stream = cameraStream.current;
    if (!stream || !cameraReady || recording) return;
    if (!("MediaRecorder" in window)) {
      setCameraError("Этот браузер не поддерживает запись внутри приложения. Используйте кнопку обычной камеры.");
      return;
    }
    const mimeType = recordingMimeType();
    try {
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined,
      );
      recordedChunks.current = [];
      setCapturedVideo(null);
      setRecordingSeconds(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunks.current.push(event.data);
      };
      recorder.onstop = () => {
        const actualType = recorder.mimeType || mimeType || "video/webm";
        const extension = actualType.includes("mp4") ? "mp4" : "webm";
        const blob = new Blob(recordedChunks.current, { type: actualType });
        if (blob.size > 0) {
          setCapturedVideo(new File(
            [blob],
            `video-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
            { type: actualType },
          ));
        }
        recordedChunks.current = [];
        setRecording(false);
        if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
        recordingTimer.current = null;
      };
      mediaRecorder.current = recorder;
      recorder.start(1000);
      setRecording(true);
      recordingTimer.current = window.setInterval(() => {
        setRecordingSeconds((current) => {
          if (current >= 599) window.setTimeout(stopVideoRecording, 0);
          return current + 1;
        });
      }, 1000);
    } catch {
      setCameraError("Этот браузер не смог начать запись. Используйте запасную кнопку камеры.");
    }
  }

  function stopVideoRecording() {
    if (mediaRecorder.current?.state === "recording") mediaRecorder.current.stop();
  }

  function discardCapturedVideo() {
    setCapturedVideo(null);
    setRecordingSeconds(0);
  }

  function stageCapturedVideo() {
    if (!capturedVideo) return;
    const file = capturedVideo;
    closeCamera();
    stageFiles([file]);
  }

  function capturePhoto() {
    const video = cameraVideo.current;
    if (!video || !cameraReady || capturedFiles.length >= 20) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const suffix = String(capturedFiles.length + 1).padStart(2, "0");
      setCapturedFiles((current) => [
        ...current,
        new File([blob], `camera-${new Date().toISOString().replace(/[:.]/g, "-")}-${suffix}.jpg`, { type: "image/jpeg" }),
      ]);
    }, "image/jpeg", 0.92);
  }

  function stageCapturedSeries() {
    if (capturedFiles.length === 0) return;
    const files = [...capturedFiles];
    closeCamera();
    stageFiles(files);
  }

  async function remove(file: Media) {
    if (!window.confirm(`Переместить «${file.original_name}» в корзину?`)) return;
    try {
      await api<void>(`/media/${file.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      setPreview((current) => current?.id === file.id ? null : current);
      await loadFiles();
      setWorkspaces(await api<Workspace[]>("/workspaces"));
      await loadCalendarVisits();
      window.dispatchEvent(new Event("vita29:storage-changed"));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Ошибка удаления");
    }
  }

  function openMove(file: Media) {
    const destination = workspaces.find((workspace) => workspace.id !== file.workspace_id);
    if (!destination) {
      setMessage("Нет другой доступной папки");
      return;
    }
    setMoving(file);
    setMoveWorkspace(destination.id);
  }

  async function move() {
    if (!moving || !moveWorkspace) return;
    setBusy(true);
    setMessage("");
    try {
      const destination = workspaces.find((workspace) => workspace.id === moveWorkspace);
      await api<Media>(`/media/${moving.id}/workspace`, {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ workspace_id: moveWorkspace }),
      });
      setMoving(null);
      setPreview(null);
      setMessage(`Файл перемещён в папку «${destination?.display_name ?? "выбранную"}»`);
      await loadFiles();
      setWorkspaces(await api<Workspace[]>("/workspaces"));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось переместить файл");
    } finally {
      setBusy(false);
    }
  }

  async function sharePreparedVideo(file: Media, shareFile: File) {
    const payload = { files: [shareFile] };
    if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
      try {
        await navigator.share(payload);
        preparedShareFiles.current.delete(file.id);
        setShareProgress((current) => {
          const next = { ...current };
          delete next[file.id];
          return next;
        });
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        if (reason instanceof DOMException && reason.name === "NotAllowedError") {
          setMessage("Видео готово. Нажмите «Поделиться» ещё раз.");
          return;
        }
        setMessage(reason instanceof Error ? reason.message : "Не удалось поделиться видео");
      }
      return;
    }
    const url = URL.createObjectURL(shareFile);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.original_name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setMessage("Видео скачано. Поделиться им можно из галереи телефона.");
  }

  function openDownload(file: Media) {
    const anchor = document.createElement("a");
    anchor.href = `/api/v1/media/${file.id}/download`;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.click();
    setMessage("Файл открыт отдельно. После сохранения закройте это окно — приложение останется открытым.");
  }

  function share(file: Media) {
    if (!file.publication_allowed) {
      setMessage("Для этого файла публикация запрещена. Сначала разрешите её через меню •••.");
      return;
    }

    setMessage("");

    if (file.media_type === "video") {
      const shareFile = preparedShareFiles.current.get(file.id);
      if (shareFile) {
        void sharePreparedVideo(file, shareFile);
        return;
      }
      setMessage("Подготавливаем видео к отправке…");
      void prepareVideoForShare(file)
        .then((readyFile) => sharePreparedVideo(file, readyFile))
        .catch(() => undefined);
      return;
    }

    void (async () => {
      try {
      const response = await fetch(`/api/v1/media/${file.id}/download`);
      if (!response.ok) {
        throw new Error("Не удалось подготовить файл");
      }

      const blob = await response.blob();
      const shareFile = new File(
        [blob],
        file.original_name,
        { type: file.mime_type },
      );

      const payload = {
        files: [shareFile],
        title: file.original_name,
      };

      if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
        await navigator.share(payload);
        return;
      }

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.original_name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage(
        file.media_type === "video"
          ? "Видео скачано. Поделиться им можно из галереи телефона."
          : "Файл скачан. Поделиться им можно из галереи телефона.",
      );
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setMessage(reason instanceof Error ? reason.message : "Не удалось поделиться файлом");
      }
    })();
  }

  function openComment(file: Media) {
    setCommenting(file);
    setMediaComment(file.comment || file.batch_comment || "");
    void api<DiscussionParticipant[]>("/discussions/participants")
      .then(setCommentParticipants)
      .catch(() => undefined);
  }

  useEffect(() => {
    if (!commenting) return;
    const refresh = () => { if (document.visibilityState !== "hidden") void api<DiscussionParticipant[]>("/discussions/participants").then(setCommentParticipants).catch(() => undefined); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("violetta-users-changed", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("violetta-users-changed", refresh); };
  }, [commenting?.id]);

  const commentMentionMatch = mediaComment.match(/(?:^|\s)@([^@\n]*)$/);
  const commentMentionQuery = commentMentionMatch?.[1].trim().toLocaleLowerCase("ru-RU") ?? "";
  const commentMentionOptions = commentMentionMatch && commenting?.workspace_kind !== "private"
    ? commentParticipants.filter((item) => item.display_name.toLocaleLowerCase("ru-RU").includes(commentMentionQuery)).slice(0, 8)
    : [];

  function insertCommentMention(displayName: string) {
    const mentionStart = mediaComment.lastIndexOf("@");
    if (mentionStart < 0) return;
    setMediaComment(`${mediaComment.slice(0, mentionStart)}@${displayName} `);
  }

  async function saveMediaComment() {
    if (!commenting) return;
    setBusy(true);
    setMessage("");
    try {
      const updated = await api<Media>(`/media/${commenting.id}/comment`, {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ comment: mediaComment.trim() || null }),
      });
      setFiles((current) => current.map((item) => item.id === updated.id ? updated : item));
      setPreview((current) => current?.id === updated.id ? updated : current);
      setCommenting(null);
      setMessage(mediaComment.trim() ? "Комментарий сохранён" : "Комментарий удалён");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось сохранить комментарий");
    } finally {
      setBusy(false);
    }
  }

  async function updatePublication(file: Media, allowed: boolean) {
    setMessage("");
    try {
      const updated = await api<Media>(`/media/${file.id}/publication`, {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ publication_allowed: allowed }),
      });
      setFiles((current) => current.map((item) => item.id === updated.id ? updated : item));
      setPreview((current) => current?.id === updated.id ? updated : current);
      setMessage(allowed ? "Публикация и кнопка «Поделиться» разрешены" : "Публикация и кнопка «Поделиться» заблокированы");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось изменить разрешение");
    }
  }

  async function updateContentMark(file: Media, marked: boolean) {
    setMessage("");
    try {
      const updated = await api<Media>(`/media/${file.id}/content-mark`, {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ content_marked: marked }),
      });
      setFiles((current) => current.map((item) => item.id === updated.id ? updated : item));
      setPreview((current) => current?.id === updated.id ? updated : current);
      setMessage(marked ? "Материал отмечен для контента" : "Отметка «для контента» снята");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось изменить отметку контента");
    }
  }

  return (
    <section className={`media-panel media-page-panel ${mode}`}>
      <div className="section-heading"><div><p className="eyebrow">Папки сотрудников</p><h2>{browseAcrossWorkspaces ? "Материалы из всех папок" : activeWorkspaceInfo?.display_name || "Фото и видео"}</h2>{!browseAcrossWorkspaces && activeWorkspaceInfo?.kind === "private" && <small className="private-note">🔒 Доступ ограничен</small>}</div><span>{browseAcrossWorkspaces ? `${files.length}${hasMore ? "+" : ""}` : activeWorkspaceInfo?.file_count ?? files.length}</span></div>
      {(session.user.can_create_shared_workspaces || session.user.can_create_private_workspaces) && <details className="workspace-create">
        <summary>＋ Создать папку</summary>
        <form onSubmit={createWorkspace}>
          <label>Название<input name="display_name" required minLength={2} maxLength={120} placeholder="Например, Брови" /></label>
          <label>Доступ<select name="kind">
            {session.user.can_create_shared_workspaces && <option value="studio">Общая — видят все</option>}
            {session.user.can_create_private_workspaces && <option value="private">Приватная — только моя</option>}
          </select></label>
          <button className="primary" disabled={creatingFolder}>{creatingFolder ? "Создаём…" : "Создать"}</button>
        </form>
      </details>}
      <details className="workspace-picker" ref={workspacePicker}>
        <summary><span>Выбрать папку</span><small>{workspaces.length}</small></summary>
        <div className="workspace-tabs" aria-label="Папки сотрудников">
          {privateWorkspaces.length > 0 && <p className="workspace-group-label">Приватные папки</p>}
          {privateWorkspaces.map((workspace) => <button className={`${activeWorkspace === workspace.id ? "active" : ""} private`} key={workspace.id} onClick={() => { void chooseWorkspace(workspace.id); }}><span aria-hidden="true">🔒</span><b>{workspace.display_name}</b><small className="workspace-stats">{workspace.file_count} · {formatStorageSize(workspace.size_bytes)}</small></button>)}
          {sharedWorkspaces.length > 0 && <p className="workspace-group-label shared">Общие папки</p>}
          {sharedWorkspaces.map((workspace) => <button className={activeWorkspace === workspace.id ? "active" : ""} key={workspace.id} onClick={() => { void chooseWorkspace(workspace.id); }}><span aria-hidden="true">▰</span><b>{workspace.display_name}</b><small className="workspace-stats">{workspace.file_count} · {formatStorageSize(workspace.size_bytes)}</small></button>)}
        </div>
      </details>
      {mode === "add" && <>
      {uploadWorkspaceInfo?.kind !== "private" && <details className="visit-picker" open>
        <summary><span>Визит YCLIENTS</span><small>{selectedVisitId === null ? "Без привязки" : "Выбран"}</small></summary>
        <div className="visit-picker-body">
          {session.user.role !== "employee" && !canSwitchAllCalendars && calendarUsers.length > 0 && <label className="calendar-user">Сотрудник<select value={calendarUser} onChange={(event) => setCalendarUser(event.target.value)}>{calendarUsers.map((item) => <option key={item.user_id} value={item.user_id}>{item.display_name}</option>)}</select></label>}
          {canSwitchAllCalendars && <div className="calendar-scope" aria-label="Режим календаря"><button type="button" className={!calendarAll ? "active" : ""} onClick={() => setCalendarAll(false)}>Мой календарь</button><button type="button" className={calendarAll ? "active" : ""} onClick={() => setCalendarAll(true)}>Все календари</button></div>}
          <label className="calendar-month">Месяц<input type="month" value={calendarMonth} onChange={(event) => setCalendarMonth(event.target.value)} /></label>
          <label className="calendar-client-search">Клиент<input type="search" value={calendarClientSearch} placeholder="Введите ФИО клиента" onChange={(event) => setCalendarClientSearch(event.target.value)} /></label>
          <div className="calendar-weekdays" aria-hidden="true">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="visit-calendar" aria-label="Календарь визитов">
            {Array.from({ length: calendarOffset }, (_, index) => <span className="calendar-empty" key={`empty-${index}`} />)}
            {Array.from({ length: calendarDayCount }, (_, index) => {
              const day = index + 1;
              const key = `${calendarMonth}-${String(day).padStart(2, "0")}`;
              const dayVisits = visitsByDate[key] ?? [];
              const filledVisits = dayVisits.filter((visit) => visit.media_count > 0).length;
              return <button type="button" key={key} className={`${dayVisits.length ? "has-visits" : ""} ${filledVisits ? "has-media" : ""} ${filledVisits === dayVisits.length && dayVisits.length ? "complete" : ""} ${selectedVisitDate === key ? "active" : ""}`} disabled={!dayVisits.length} onClick={() => { setSelectedVisitDate(key); setSelectedVisitId(null); }}><b>{day}</b>{dayVisits.length > 0 && <small title="Всего визитов / с файлами">{dayVisits.length}/{filledVisits}</small>}</button>;
            })}
          </div>
          {calendarLoading && <p className="calendar-status">Загружаем визиты…</p>}
          {!calendarLoading && visits.length === 0 && <p className="calendar-status">На этот месяц визитов пока нет.</p>}
          {!calendarLoading && visits.length > 0 && visibleVisits.length === 0 && <p className="calendar-status">Клиент с таким ФИО не найден.</p>}
          {selectedVisitDate && <div className="visit-list">
            <button type="button" className={selectedVisitId === null ? "active" : ""} onClick={() => setSelectedVisitId(null)}>Без привязки к визиту</button>
            {selectedVisits.map((visit) => <button type="button" key={visit.record_id} className={`${visit.media_count > 0 ? "with-media" : ""} ${selectedVisitId === visit.record_id ? "active" : ""}`} onClick={() => setSelectedVisitId(visit.record_id)}><strong>{new Date(visit.starts_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} · {visit.client_name || "Клиент"}</strong>{calendarAll && visit.staff_name && <i>{visit.staff_name}</i>}{visit.media_count > 0 && <em>✓ Файлы добавлены: {visit.media_count}</em>}{visit.services.length > 0 && <span>{visit.services.join(", ")}</span>}{visit.comment && <small>{visit.comment}</small>}</button>)}
          </div>}
        </div>
      </details>}
      {uploadWorkspaceInfo?.kind !== "private" ? <fieldset className="publication-choice">
        <legend>Можно публиковать?</legend>
        <label className={publicationAllowed ? "active allowed" : ""}><input type="radio" name="publication" checked={publicationAllowed} onChange={() => setPublicationAllowed(true)} /><span>✓ Можно</span></label>
        <label className={!publicationAllowed ? "active forbidden" : ""}><input type="radio" name="publication" checked={!publicationAllowed} onChange={() => setPublicationAllowed(false)} /><span>⛔ Запрещено</span></label>
      </fieldset> : <p className="private-publication-note">✓ В приватной папке публикация разрешена</p>}
      <label className="workspace-select">Загрузить в папку<select value={uploadWorkspace} onChange={(event) => { const workspaceId = event.target.value; setUploadWorkspace(workspaceId); localStorage.setItem(uploadWorkspaceStorageKey, workspaceId); if (workspaces.find((workspace) => workspace.id === workspaceId)?.kind === "private") { setSelectedVisitId(null); setPublicationAllowed(true); } }}>{privateWorkspaces.length > 0 && <optgroup label="Приватные папки">{privateWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>🔒 {workspace.display_name}</option>)}</optgroup>}{sharedWorkspaces.length > 0 && <optgroup label="Общие папки">{sharedWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.display_name}</option>)}</optgroup>}</select></label>
      <div className="upload-actions">
        <label className={`upload-button ${busy ? "disabled" : ""}`}>＋ Из галереи<input type="file" accept="image/*,video/*,.heic,.heif,.avif" multiple disabled={busy || !uploadWorkspace} onChange={(event) => { stageFiles(event.target.files); event.target.value = ""; }} /></label>
        <button className={`camera-button ${busy ? "disabled" : ""}`} type="button" disabled={busy || !uploadWorkspace} onClick={() => { setCameraMode("photo"); setCameraOpen(true); }}>Фото · серия</button>
        <button className={`camera-button video-camera-button ${busy ? "disabled" : ""}`} type="button" disabled={busy || !uploadWorkspace} onClick={() => { setCameraMode("video"); setCameraOpen(true); }}>● Снять видео</button>
      </div>
      </>}
      {mode === "browse" && <>
      {(browseAcrossWorkspaces || activeWorkspaceInfo?.kind !== "private") && <details className="visit-picker browse-calendar" open>
        <summary><span>Календарь визитов</span><small>{browseVisitId !== null ? "Выбран визит" : browseVisitDate ? "Выбран день" : "Все материалы"}</small></summary>
        <div className="visit-picker-body">
          {session.user.role !== "employee" && !canSwitchAllCalendars && calendarUsers.length > 0 && <label className="calendar-user">Сотрудник<select value={calendarUser} onChange={(event) => setCalendarUser(event.target.value)}>{calendarUsers.map((item) => <option key={item.user_id} value={item.user_id}>{item.display_name}</option>)}</select></label>}
          {canSwitchAllCalendars && <div className="calendar-scope" aria-label="Режим календаря"><button type="button" className={!calendarAll ? "active" : ""} onClick={() => setCalendarAll(false)}>Мой календарь</button><button type="button" className={calendarAll ? "active" : ""} onClick={() => setCalendarAll(true)}>Все календари</button></div>}
          <label className="calendar-month">Месяц<input type="month" value={calendarMonth} onChange={(event) => setCalendarMonth(event.target.value)} /></label>
          <label className="calendar-client-search">Клиент<input type="search" value={browseClientSearch} placeholder="Введите ФИО клиента" onChange={(event) => { setBrowseClientSearch(event.target.value); setBrowseVisitDate(""); setBrowseVisitId(null); }} /></label>
          <div className="calendar-weekdays" aria-hidden="true">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="visit-calendar" aria-label="Календарь просмотра">
            {Array.from({ length: calendarOffset }, (_, index) => <span className="calendar-empty" key={`browse-empty-${index}`} />)}
            {Array.from({ length: calendarDayCount }, (_, index) => {
              const day = index + 1;
              const key = `${calendarMonth}-${String(day).padStart(2, "0")}`;
              const dayVisits = browseVisitsByDate[key] ?? [];
              const filledVisits = dayVisits.filter((visit) => visit.media_count > 0).length;
              return <button type="button" key={key} className={`${dayVisits.length ? "has-visits" : ""} ${filledVisits ? "has-media" : ""} ${filledVisits === dayVisits.length && dayVisits.length ? "complete" : ""} ${browseVisitDate === key ? "active" : ""}`} disabled={!dayVisits.length} onClick={() => { void selectBrowseDay(key); }}><b>{day}</b>{dayVisits.length > 0 && <small title="Всего визитов / с файлами">{dayVisits.length}/{filledVisits}</small>}</button>;
            })}
          </div>
          {calendarLoading && <p className="calendar-status">Загружаем визиты…</p>}
          {!calendarLoading && visits.length === 0 && <p className="calendar-status">На этот месяц визитов пока нет.</p>}
          {!calendarLoading && visits.length > 0 && browseVisibleVisits.length === 0 && <p className="calendar-status">Клиент с таким ФИО не найден.</p>}
          {browseVisitDate && <div className="visit-list browse-visit-list">
            <button type="button" className={browseVisitId === null ? "active" : ""} onClick={() => { void selectBrowseDay(browseVisitDate); }}><strong>Все материалы за этот день</strong></button>
            {browseSelectedVisits.map((visit) => <button type="button" key={visit.record_id} className={`${visit.media_count > 0 ? "with-media" : ""} ${browseVisitId === visit.record_id ? "active" : ""}`} onClick={() => { void selectBrowseVisit(visit.record_id); }}><strong>{new Date(visit.starts_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} · {visit.client_name || "Клиент"}</strong>{calendarAll && visit.staff_name && <i>{visit.staff_name}</i>}<em>{visit.media_count > 0 ? `Файлов: ${visit.media_count}` : "Файлов пока нет"}</em>{visit.services.length > 0 && <span>{visit.services.join(", ")}</span>}{visit.comment && <small>{visit.comment}</small>}</button>)}
          </div>}
        </div>
      </details>}

      {!browseAcrossWorkspaces && activeWorkspaceInfo?.kind === "private" && <section className="private-archive-filter iphone-filter" aria-label="Поиск в приватном архиве">
        <div className="private-filter-heading"><strong>Медиатека</strong><small>По времени съёмки и местам — как в «Фото» на iPhone</small></div>
        <div className="private-filter-section">
          <span>Годы</span>
          <div className="private-filter-chips year-chips">
            <button type="button" className={!captureYear ? "active" : ""} onClick={() => { void applyPrivateArchiveFilter("", "", ""); }}>Все</button>
            {privateFilterOptions.years.map((year) => <button type="button" className={captureYear === String(year) ? "active" : ""} key={year} onClick={() => { void applyPrivateArchiveFilter(String(year), "", ""); }}>{year}</button>)}
          </div>
        </div>
        {captureYear && <div className="private-filter-section month-section">
          <span>Месяцы {captureYear}</span>
          <div className="private-month-grid">
            <button type="button" className={!captureMonth ? "active" : ""} onClick={() => { void applyPrivateArchiveFilter(captureYear, "", ""); }}><b>Все месяцы</b><small>{availablePrivateMonths.reduce((total, item) => total + item.count, 0)} файлов</small></button>
            {availablePrivateMonths.map((item) => <button type="button" className={captureMonth === String(item.month) ? "active" : ""} key={`${item.year}-${item.month}`} onClick={() => { void applyPrivateArchiveFilter(captureYear, String(item.month), ""); }}><b>{MONTH_NAMES[item.month - 1]}</b><small>{item.count} файлов</small></button>)}
          </div>
        </div>}
        <label className="private-place-filter">Места<select value={locationKey} onChange={(event) => { void applyPrivateArchiveFilter(captureYear, captureMonth, event.target.value); }}><option value="">Все места</option>{privateFilterOptions.places.map((place) => <option key={place.key} value={place.key}>{place.label}</option>)}{privateFilterOptions.without_location_count > 0 && <option value="__none__">Без геопозиции</option>}</select></label>
        {privateFilterLoading && <p className="private-filter-loading" aria-live="polite"><span /> Обновляем фотографии…</p>}
      </section>}

      {(browseAcrossWorkspaces || activeWorkspaceInfo?.kind !== "private") && <form className="date-filter" onSubmit={applyDateFilter} aria-label="Фильтр по дате съёмки">
        <label className="procedure-filter">Процедура<input type="search" value={procedureSearch} placeholder="Например, брови" onChange={(event) => setProcedureSearch(event.target.value)} /></label>
        <label>С даты<input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} /></label>
        <label>По дату<input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} /></label>
        <button className="filter-apply" type="submit">Показать</button>
        {(dateFrom || dateTo || captureYear || captureMonth || locationKey || procedureSearch || browseClientSearch || browseVisitId !== null) && <button className="filter-clear" type="button" onClick={() => { void clearDateFilter(); }}>Сбросить</button>}
      </form>}
      </>}
      {message && <p className="upload-message" aria-live="polite">{message}</p>}
      {mode === "browse" && <details className="media-action-legend"><summary>Обозначения кнопок</summary><div><span><b>✦</b> Выбрать для генерации контента</span><span><b>●</b> Бирюзовая ✦ — отмечено для контента</span><span><b>↗</b> Поделиться</span><span><b>💬</b> Комментарий</span><span><b>◌</b> Создать чат</span><span><b>⇄</b> В другую папку</span><span><b>↓</b> Скачать</span><span><b>⛔</b> Запретить публикацию</span><span><b>×</b> Удалить</span></div></details>}
      {mode === "browse" && (files.length === 0 ? <div className="empty"><strong>Здесь пока пусто</strong><span>В этой папке пока нет фото или видео.</span></div> : (
        <><div className="media-grid">{files.map((file) => (
          <article className="media-card" key={file.id}>
            {!file.publication_allowed && <span className="no-publish-badge" title="Публикация запрещена" aria-label="Публикация запрещена">⛔</span>}
            {effectiveComment(file) && <span className="comment-badge" title={effectiveComment(file) || ""}>💬</span>}
            {session.user.can_access_content && file.publication_allowed && <button className={`content-select-on-media ${contentSelection.includes(file.id) ? "selected" : ""} ${file.content_marked ? "marked" : ""}`} type="button" title={file.content_marked ? "Материал отмечен для контента; нажмите, чтобы выбрать для этой генерации" : "Выбрать для создания контента"} aria-pressed={contentSelection.includes(file.id)} onClick={() => setContentSelection((current) => current.includes(file.id) ? current.filter((id) => id !== file.id) : [...current, file.id].slice(0, 4))}>{contentSelection.includes(file.id) ? "✓" : "✦"}</button>}
            <button className={`media-visual ${file.media_type}`} onClick={() => setPreview(file)} aria-label={`Открыть ${file.original_name}`}>
              <img src={`/api/v1/media/${file.id}/thumbnail`} alt="" loading="lazy" />
              {file.media_type === "video" && <span className="video-play" aria-hidden="true">▶</span>}
            </button>
            {contentSelection[0] === file.id && <button className="generate-on-media" type="button" onClick={() => onCreateContent(files.filter((entry) => contentSelection.includes(entry.id)))}>✦ Создать контент / обработать фото{contentSelection.length > 1 ? ` · ${contentSelection.length} фото` : ""}</button>}
            {file.media_type === "video" && <div className={`video-share-progress ${shareProgress[file.id] === 100 ? "ready" : ""}`}><span style={{ width: `${shareProgress[file.id] ?? 0}%` }} /><b>{shareProgress[file.id] === 100 ? "Готово к отправке · 100%" : `Подготовка видео · ${shareProgress[file.id] ?? 0}%`}</b></div>}
            <div className="card-actions">
              <button className={`share-card ${file.publication_allowed ? "" : "blocked"} ${videoIsPreparing(file) ? "preparing" : ""}`} disabled={!file.publication_allowed || videoIsPreparing(file)} onClick={() => share(file)}><span aria-hidden="true">↗</span> {!file.publication_allowed ? "Запрещено" : videoIsPreparing(file) ? `Готовим ${shareProgress[file.id]}%` : "Поделиться"}</button>
              <details className="card-more">
                <summary title="Другие действия" aria-label="Другие действия">•••</summary>
                <div className="card-more-actions">
                  <button className="move-action" onClick={() => openMove(file)} title="Переместить в папку" aria-label="Переместить в папку">⇄</button>
                  <button onClick={() => openDownload(file)} title="Скачать" aria-label="Скачать">↓</button>
                  {session.user.can_access_content && file.publication_allowed && <button onClick={() => onCreateContent([file])} title="Создать контент или обработать фото" aria-label="Создать контент или обработать фото">✦</button>}
                  {session.user.can_access_content && file.publication_allowed && <button className={file.content_marked ? "content-mark-action marked" : "content-mark-action"} onClick={() => void updateContentMark(file, !file.content_marked)} title={file.content_marked ? "Снять отметку для контента" : "Отметить для контента"} aria-label={file.content_marked ? "Снять отметку для контента" : "Отметить для контента"}>{file.content_marked ? "●" : "○"}</button>}
                  {session.user.can_add_comments && <button onClick={() => openComment(file)} title="Добавить или изменить комментарий" aria-label="Добавить или изменить комментарий">💬</button>}
                  {session.user.can_access_chats && <button onClick={() => onCreateChat(file)} title="Создать чат с этим файлом" aria-label="Создать чат с этим файлом">◌</button>}
                  {file.workspace_kind !== "private" && <button className={`publication-action ${file.publication_allowed ? "allowed" : "forbidden"}`} onClick={() => { void updatePublication(file, !file.publication_allowed); }} title={file.publication_allowed ? "Запретить публикацию" : "Разрешить публикацию"} aria-label={file.publication_allowed ? "Запретить публикацию" : "Разрешить публикацию"}>{file.publication_allowed ? "⛔" : "✓"}</button>}
                  {file.can_delete && <button className="danger" onClick={() => { void remove(file); }} title="Удалить" aria-label="Удалить">×</button>}
                </div>
              </details>
            </div>
          </article>
        ))}</div>{hasMore && <div className="load-more-wrap"><button className="load-more" disabled={loadingMore} onClick={() => { void loadMore(); }}>{loadingMore ? "Загружаем…" : `Показать ещё ${MEDIA_PAGE_SIZE}`}</button><small>Сейчас показано: {files.length}</small></div>}</>
      ))}
      {mode === "browse" && preview && <div className="preview-overlay" role="dialog" aria-modal="true" aria-label={preview.original_name} onClick={() => setPreview(null)}>
        <div className="preview-dialog" onClick={(event) => event.stopPropagation()}>
          <button className="preview-close" onClick={() => setPreview(null)} aria-label="Закрыть">×</button>
          <div className="preview-stage" onTouchStart={(event) => { const touch = event.changedTouches[0]; touchStart.current = { x: touch.clientX, y: touch.clientY }; }} onTouchEnd={(event) => { const start = touchStart.current; const touch = event.changedTouches[0]; touchStart.current = null; if (!start) return; const deltaX = touch.clientX - start.x; const deltaY = touch.clientY - start.y; if (Math.abs(deltaX) > 45 && Math.abs(deltaX) > Math.abs(deltaY)) showAdjacent(deltaX > 0 ? -1 : 1); }}>
            {!preview.publication_allowed && <span className="preview-no-publish">⛔ Публикация запрещена</span>}
            {previewIndex > 0 && <button className="preview-arrow previous" onClick={() => showAdjacent(-1)} aria-label="Предыдущее фото">‹</button>}
            {preview.media_type === "image" ? <img src={`/api/v1/media/${preview.id}/preview`} alt={preview.original_name} draggable="false" /> : <video src={`/api/v1/media/${preview.id}/preview`} controls autoPlay playsInline />}
            {previewIndex < files.length - 1 && <button className="preview-arrow next" onClick={() => showAdjacent(1)} aria-label="Следующее фото">›</button>}
            <span className="preview-counter">{previewIndex + 1} / {files.length}</span>
          </div>
          {effectiveComment(preview) && (
              <div className="preview-comment">
                💬 {effectiveComment(preview)}
              </div>
            )}
            <div className="preview-footer">
              <button className={`share-primary preview-share ${preview.publication_allowed ? "" : "blocked"}`} disabled={!preview.publication_allowed || videoIsPreparing(preview)} onClick={() => share(preview)}><span aria-hidden="true">↗</span> {!preview.publication_allowed ? "Публикация запрещена" : videoIsPreparing(preview) ? `Подготовка видео · ${shareProgress[preview.id]}%` : "Поделиться"}</button>
              <div className="preview-actions">
                <button className="move-preview" onClick={() => openMove(preview)}>⇄ В папку</button>
                <button onClick={() => openDownload(preview)}>↓ Скачать</button>
                {session.user.can_access_content && preview.publication_allowed && <button onClick={() => { const file = preview; setPreview(null); onCreateContent([file]); }}>✦ Создать контент / обработать фото</button>}
                {session.user.can_access_content && preview.publication_allowed && <button className={preview.content_marked ? "content-mark-action marked" : "content-mark-action"} onClick={() => void updateContentMark(preview, !preview.content_marked)}>{preview.content_marked ? "● Убрать отметку контента" : "○ Отметить для контента"}</button>}
                {session.user.can_add_comments && <button onClick={() => openComment(preview)}>💬 Комментарий</button>}
                {session.user.can_access_chats && <button onClick={() => { const file = preview; setPreview(null); onCreateChat(file); }}>◌ Создать чат</button>}
                {preview.workspace_kind !== "private" && <button className={`publication-toggle-preview ${preview.publication_allowed ? "allowed" : "forbidden"}`} onClick={() => { void updatePublication(preview, !preview.publication_allowed); }}>{preview.publication_allowed ? "⛔ Запретить" : "✓ Разрешить"}</button>}
                {preview.can_delete && <button className="preview-delete" onClick={() => { void remove(preview); }}>× Удалить</button>}
              </div>
            </div>
        </div>
      </div>}
      {pendingFiles.length > 0 && <div
  className="move-overlay"
  role="dialog"
  aria-modal="true"
  aria-label="Сохранить фото и видео"
  onClick={() => { if (!busy) cancelPendingBatch(); }}
>
  <div className="move-dialog" onClick={(event) => event.stopPropagation()}>
    <h2>Сохранить материалы</h2>
    <p>
      Выбрано файлов: <strong>{pendingFiles.length}</strong>
    </p>
    {session.user.can_add_comments && <label>
      Комментарий к серии
      <textarea
        value={batchComment}
        maxLength={4000}
        rows={5}
        placeholder="Комментарий можно оставить пустым"
        onChange={(event) => setBatchComment(event.target.value)}
      />
    </label>}
    <div className="move-actions">
      <button
        className="quiet"
        type="button"
        disabled={busy}
        onClick={cancelPendingBatch}
      >
        Отмена
      </button>
      <button
        className="primary"
        type="button"
        disabled={busy}
        onClick={() => { void savePendingBatch(); }}
      >
        {busy ? "Сохраняем…" : "Сохранить"}
      </button>
    </div>
  </div>
</div>}
      {commenting && <div className="move-overlay" role="dialog" aria-modal="true" aria-label="Комментарий к файлу" onClick={() => { if (!busy) setCommenting(null); }}>
        <div className="move-dialog" onClick={(event) => event.stopPropagation()}>
          <h2>Комментарий</h2>
          <p>{commenting.original_name}</p>
          <label>Комментарий к фото или видео<div className="comment-mention-input">{commentMentionOptions.length > 0 && <div className="mention-suggestions" role="listbox" aria-label="Упомянуть сотрудника">{commentMentionOptions.map((item) => <button type="button" role="option" key={item.id} onClick={() => insertCommentMention(item.display_name)}><span>{item.display_name.slice(0, 1).toLocaleUpperCase("ru-RU")}</span><strong>{item.display_name}</strong></button>)}</div>}<textarea value={mediaComment} maxLength={4000} rows={5} placeholder="Комментарий… Введите @ для выбора сотрудника" onChange={(event) => setMediaComment(event.target.value)} /></div></label>
          <div className="move-actions"><button className="quiet" type="button" disabled={busy} onClick={() => setCommenting(null)}>Отмена</button><button className="primary" type="button" disabled={busy} onClick={() => { void saveMediaComment(); }}>{busy ? "Сохраняем…" : "Сохранить"}</button></div>
        </div>
      </div>}
{cameraOpen && <div className="camera-overlay" role="dialog" aria-modal="true" aria-label={cameraMode === "video" ? "Съёмка видео" : "Серийная фотосъёмка"}>
        <div className="camera-dialog">
          <header><strong>{cameraMode === "video" ? "Съёмка видео" : "Серийная фотосъёмка"}</strong><button onClick={() => closeCamera()} aria-label="Закрыть камеру">×</button></header>
          <div className="camera-mode-toggle" aria-label="Режим камеры">
            <button type="button" className={cameraMode === "photo" ? "active" : ""} disabled={recording} onClick={() => { setCapturedVideo(null); setCameraMode("photo"); }}>Фото</button>
            <button type="button" className={cameraMode === "video" ? "active" : ""} disabled={recording} onClick={() => { setCapturedFiles([]); setCameraMode("video"); }}>Видео</button>
          </div>
          <div className="camera-view">
            <video ref={cameraVideo} autoPlay muted playsInline />
            {!cameraReady && !cameraError && <span>Открываем камеру…</span>}
            {recording && <span className="recording-indicator">● REC</span>}
            {cameraError && <div className="camera-error"><p>{cameraError}</p><label>{cameraMode === "video" ? "Снять видео обычной камерой" : "Обычная камера"}<input type="file" accept={cameraMode === "video" ? "video/*" : "image/*"} capture="environment" onChange={(event) => {
  const selected = event.target.files;
  if (selected?.length) {
    const files = Array.from(selected);
    closeCamera();
    stageFiles(files);
  }
  event.target.value = "";
}} /></label></div>}
          </div>
          {cameraMode === "photo" ? <>
            <div className="camera-series-status"><strong>{capturedFiles.length}</strong><span>{capturedFiles.length === 1 ? "снимок" : "снимков"} в серии · максимум 20</span>{capturedFiles.length > 0 && <button onClick={() => setCapturedFiles([])}>Очистить</button>}</div>
            <div className="camera-controls"><button className="camera-cancel" onClick={() => closeCamera()}>Отмена</button><button className="camera-shutter" disabled={!cameraReady || capturedFiles.length >= 20 || busy} onClick={capturePhoto} aria-label="Сделать снимок"><span /></button><button className="camera-upload-series" disabled={capturedFiles.length === 0 || busy} onClick={stageCapturedSeries}>{`Выбрать ${capturedFiles.length || ""}`}</button></div>
          </> : <>
            <div className="camera-series-status video-status">
              <strong>{String(Math.floor(recordingSeconds / 60)).padStart(2, "0")}:{String(recordingSeconds % 60).padStart(2, "0")}</strong>
              <span>{recording ? "Идёт запись · максимум 10 минут" : capturedVideo ? `Видео готово · ${formatStorageSize(capturedVideo.size)}` : "Нажмите красную кнопку для записи"}</span>
              {capturedVideo && <button onClick={discardCapturedVideo}>Переснять</button>}
            </div>
            <div className="camera-controls video-controls"><button className="camera-cancel" onClick={() => closeCamera()}>Отмена</button><button className={`video-record-button ${recording ? "recording" : ""}`} disabled={!cameraReady || busy || Boolean(capturedVideo)} onClick={recording ? stopVideoRecording : startVideoRecording} aria-label={recording ? "Остановить запись" : "Начать запись"}><span /></button><button className="camera-upload-series" disabled={!capturedVideo || recording || busy} onClick={stageCapturedVideo}>Использовать</button></div>
          </>}
        </div>
      </div>}
      {moving && <div className="move-overlay" role="dialog" aria-modal="true" aria-label="Переместить файл" onClick={() => setMoving(null)}>
        <div className="move-dialog" onClick={(event) => event.stopPropagation()}>
          <h2>Переместить файл</h2>
          <p>{moving.original_name}</p>
          <label>Новая папка<select value={moveWorkspace} onChange={(event) => setMoveWorkspace(event.target.value)}>{workspaces.filter((workspace) => workspace.id !== moving.workspace_id).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.kind === "private" ? "🔒 " : ""}{workspace.display_name}</option>)}</select></label>
          <div className="move-actions"><button className="quiet" disabled={busy} onClick={() => setMoving(null)}>Отмена</button><button className="primary" disabled={busy} onClick={() => { void move(); }}>{busy ? "Переносим…" : "Переместить"}</button></div>
        </div>
      </div>}
    </section>
  );
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      onLogin(await api<Session>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ login: form.get("login"), password: form.get("password") }),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ошибка входа");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="login-layout" aria-labelledby="page-title">
        <div className="login-brand">
          <img className="mark" src="/logo.svg" alt="" />
          <div className="brand-copy"><span>VIOLETTA</span><small>studio</small></div>
          <p>Красота начинается<br />с уверенности в себе.</p>
          <em>Делаем как себе!</em>
        </div>
        <div className="card login-card">
          <p className="eyebrow">Файлы студии</p>
          <h1 id="page-title">Добро пожаловать</h1>
          <p className="description">Войдите в своё рабочее пространство.</p>
          <form onSubmit={submit}>
            <label>Логин<input name="login" autoComplete="username" required /></label>
            <label>Пароль<input name="password" type="password" autoComplete="current-password" required /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>{busy ? "Входим…" : "Войти"}</button>
          </form>
          <p className="login-help">Пароль выдаёт администратор студии</p>
        </div>
      </section>
    </main>
  );
}

function DiscussionsPanel({ session, initialMediaId, onInitialMediaHandled }: { session: Session; initialMediaId: string | null; onInitialMediaHandled: () => void }) {
  const [discussions, setDiscussions] = useState<DiscussionSummary[]>([]);
  const [participants, setParticipants] = useState<DiscussionParticipant[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<DiscussionMessageItem[]>([]);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<DiscussionMessageItem | null>(null);
  const [selectedMedia, setSelectedMedia] = useState<string[]>([]);
  const [linkedBatchId, setLinkedBatchId] = useState<string | null>(null);
  const [library, setLibrary] = useState<DiscussionMedia[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchClient, setSearchClient] = useState("");
  const [searchAuthor, setSearchAuthor] = useState("");
  const [onlyCurrentBatch, setOnlyCurrentBatch] = useState(false);
  const [notifications, setNotifications] = useState<NotificationSummary>({ unread_count: 0, notifications: [] });
  const [firstUnreadId, setFirstUnreadId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [discussionTab, setDiscussionTab] = useState<"chats" | "comments" | "private_comments">("chats");
  const [commentFilter, setCommentFilter] = useState<"all" | "mentions">("all");
  const [commentTopicSearch, setCommentTopicSearch] = useState("");
  const [discussionPreview, setDiscussionPreview] = useState<DiscussionMedia | null>(null);
  const createDiscussionDetails = useRef<HTMLDetailsElement | null>(null);
  const activeDiscussion = discussions.find((item) => item.id === activeId) ?? null;
  const normalizedTopicSearch = commentTopicSearch.trim().toLocaleLowerCase("ru-RU");
  const visibleDiscussions = discussions.filter((item) => {
    if (discussionTab === "chats") return item.kind !== "batch";
    if (item.kind !== "batch") return false;
    if (discussionTab === "private_comments" && !item.is_private) return false;
    if (discussionTab === "comments" && item.is_private) return false;
    if (discussionTab === "comments" && commentFilter === "mentions" && !item.mentioned_me) return false;
    if (!normalizedTopicSearch) return true;
    return [item.title, item.client_name, item.last_message]
      .some((value) => value?.toLocaleLowerCase("ru-RU").includes(normalizedTopicSearch));
  });
  const chatCount = discussions.filter((item) => item.kind !== "batch").length;
  const commentTopicCount = discussions.filter((item) => item.kind === "batch" && !item.is_private).length;
  const privateCommentCount = discussions.filter((item) => item.kind === "batch" && item.is_private).length;
  const totalUnread = discussions.reduce((sum, item) => sum + item.unread_count, 0);
  const unreadNotifications = notifications.notifications.filter((item) => !item.read);
  const mentionMatch = body.match(/(?:^|\s)@([^@\n]*)$/);
  const mentionQuery = mentionMatch?.[1].trim().toLocaleLowerCase("ru-RU") ?? "";
  const mentionOptions = mentionMatch
    ? participants.filter((item) => item.display_name.toLocaleLowerCase("ru-RU").includes(mentionQuery)).slice(0, 8)
    : [];

  function insertMention(displayName: string) {
    const mentionStart = body.lastIndexOf("@");
    if (mentionStart < 0) return;
    setBody(`${body.slice(0, mentionStart)}@${displayName} `);
  }

  async function loadDiscussionList(preferredId = activeId) {
    const [items, people, inbox] = await Promise.all([
      api<DiscussionSummary[]>("/discussions"),
      api<DiscussionParticipant[]>("/discussions/participants"),
      api<NotificationSummary>("/discussions/notifications/inbox"),
    ]);
    setDiscussions(items);
    setParticipants(people);
    setNotifications(inbox);
    const nextId = preferredId && items.some((item) => item.id === preferredId)
      ? preferredId
      : items.find((item) => item.unread_count > 0)?.id ?? items[0]?.id ?? "";
    if (!activeId && nextId) setActiveId(nextId);
    return nextId;
  }

  async function loadMessages(discussionId = activeId, markRead = false) {
    if (!discussionId) return;
    const params = new URLSearchParams();
    if (searchText.trim()) params.set("q", searchText.trim());
    if (searchClient.trim()) params.set("client", searchClient.trim());
    if (searchAuthor) params.set("author_id", searchAuthor);
    const selectedDiscussion = discussions.find((item) => item.id === discussionId);
    if (onlyCurrentBatch && selectedDiscussion?.batch_id) params.set("batch_id", selectedDiscussion.batch_id);
    const result = await api<DiscussionMessageItem[]>(`/discussions/${discussionId}/messages?${params.toString()}`);
    setMessages(result);
    if (markRead) {
      const last = result.at(-1);
      await api<void>(`/discussions/${discussionId}/read`, {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ message_id: last?.id ?? null }),
      });
      await loadDiscussionList(discussionId);
    }
  }

  useEffect(() => {
    void loadDiscussionList().catch(() => setMessage("Не удалось загрузить обсуждения"));
  }, []);

  useEffect(() => {
    if (!initialMediaId) return;
    setSelectedMedia([initialMediaId]);
    if (createDiscussionDetails.current) createDiscussionDetails.current.open = true;
    onInitialMediaHandled();
  }, [initialMediaId]);

  useEffect(() => {
    if (!activeId) return;
    const summary = discussions.find((item) => item.id === activeId);
    setFirstUnreadId(summary?.first_unread_message_id ?? null);
    void loadMessages(activeId, true).catch(() => setMessage("Не удалось открыть чат"));
  }, [activeId]);

  useEffect(() => {
    if (visibleDiscussions.some((item) => item.id === activeId)) return;
    setActiveId(visibleDiscussions[0]?.id ?? "");
    setMessages([]);
  }, [discussionTab, commentFilter, commentTopicSearch, discussions]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadDiscussionList(activeId).then(() => loadMessages(activeId, false)).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [activeId, searchText, searchClient, searchAuthor, onlyCurrentBatch]);

  useEffect(() => {
    if (!firstUnreadId) return;
    document.getElementById(`discussion-message-${firstUnreadId}`)?.scrollIntoView({ block: "center" });
  }, [messages, firstUnreadId]);

  async function openDiscussion(item: DiscussionSummary) {
    setDiscussionTab(item.kind === "batch" ? (item.is_private ? "private_comments" : "comments") : "chats");
    setFirstUnreadId(item.first_unread_message_id);
    setActiveId(item.id);
    setReplyTo(null);
    setSelectedMedia([]);
    setLinkedBatchId(null);
  }

  async function openNotification(item: DiscussionNotification) {
    await api<void>(`/discussions/notifications/${item.id}/read`, {
      method: "PUT",
      headers: { "X-CSRF-Token": session.csrf_token },
    });
    const discussion = discussions.find((chat) => chat.id === item.discussion_id);
    if (discussion) {
      await openDiscussion(discussion);
      await loadMessages(discussion.id, true);
    }
    await loadDiscussionList(discussion?.id ?? activeId);
  }

  async function markAllNotificationsRead() {
    await api<void>("/discussions/notifications/read-all", {
      method: "PUT",
      headers: { "X-CSRF-Token": session.csrf_token },
    });
    setNotifications((current) => ({
      unread_count: 0,
      notifications: current.notifications.map((item) => ({ ...item, read: true })),
    }));
    await loadDiscussionList(activeId);
  }

  async function createDiscussion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    try {
      const created = await api<DiscussionSummary>("/discussions", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({
          title: form.get("title"),
          member_ids: form.getAll("member_ids"),
        }),
      });
      if (selectedMedia.length > 0) {
        await api<DiscussionMessageItem>(`/discussions/${created.id}/messages`, {
          method: "POST",
          headers: { "X-CSRF-Token": session.csrf_token },
          body: JSON.stringify({
            body: null,
            attachments: selectedMedia.map((media_id) => ({ media_id })),
          }),
        });
      }
      formElement.reset();
      setSelectedMedia([]);
      setDiscussionTab("chats");
      await loadDiscussionList(created.id);
      setActiveId(created.id);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось создать чат");
    } finally {
      setBusy(false);
    }
  }

  async function openLibrary() {
    setLibraryOpen(true);
    try {
      setLibrary(await api<DiscussionMedia[]>("/discussions/media-library"));
    } catch {
      setMessage("Не удалось открыть медиатеку");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeId || (!body.trim() && selectedMedia.length === 0 && !linkedBatchId)) return;
    setBusy(true);
    try {
      await api<DiscussionMessageItem>(`/discussions/${activeId}/messages`, {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({
          body: body.trim() || null,
          reply_to_id: replyTo?.id ?? null,
          batch_id: linkedBatchId,
          attachments: selectedMedia.map((media_id) => ({ media_id })),
        }),
      });
      setBody("");
      setReplyTo(null);
      setSelectedMedia([]);
      setLinkedBatchId(null);
      await loadMessages(activeId, true);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось отправить сообщение");
    } finally {
      setBusy(false);
    }
  }

  async function toggleLike(item: DiscussionMessageItem) {
    const updated = await api<DiscussionMessageItem>(`/discussions/${activeId}/messages/${item.id}/like`, {
      method: "PUT",
      headers: { "X-CSRF-Token": session.csrf_token },
    });
    setMessages((current) => current.map((messageItem) => messageItem.id === updated.id ? updated : messageItem));
  }

  async function toggleReaction(item: DiscussionMessageItem, emoji: string) {
    const updated = await api<DiscussionMessageItem>(`/discussions/${activeId}/messages/${item.id}/reaction`, {
      method: "PUT",
      headers: { "X-CSRF-Token": session.csrf_token },
      body: JSON.stringify({ emoji }),
    });
    setMessages((current) => current.map((messageItem) => messageItem.id === updated.id ? updated : messageItem));
  }

  async function deleteDiscussion() {
    if (!activeDiscussion?.can_delete) return;
    if (!window.confirm(`Удалить чат «${activeDiscussion.title}» и все сообщения в нём?`)) return;
    setBusy(true);
    try {
      await api<void>(`/discussions/${activeDiscussion.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      setActiveId("");
      setMessages([]);
      const nextId = await loadDiscussionList("");
      setActiveId(nextId);
      setMessage("Чат удалён");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось удалить чат");
    } finally {
      setBusy(false);
    }
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      setMessage("Этот браузер не поддерживает уведомления");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      try {
        const { public_key } = await api<{ public_key: string }>("/discussions/push/public-key");
        const padding = "=".repeat((4 - (public_key.length % 4)) % 4);
        const binary = atob((public_key + padding).replace(/-/g, "+").replace(/_/g, "/"));
        const applicationServerKey = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        const subscription = existing ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        const serialized = subscription.toJSON();
        await api<void>("/discussions/push/subscriptions", {
          method: "POST",
          headers: { "X-CSRF-Token": session.csrf_token },
          body: JSON.stringify({ endpoint: serialized.endpoint, keys: serialized.keys }),
        });
        localStorage.setItem("vita29-notifications", "enabled");
        setMessage("Уведомления, значок и звуковой сигнал включены");
      } catch (reason) {
        setMessage(reason instanceof Error ? reason.message : "Не удалось включить push-уведомления");
      }
    } else {
      setMessage("Браузер не разрешил уведомления. Разрешите их в настройках сайта.");
    }
  }

  return (
    <section className="discussions-panel" id="discussions">
      <div className="section-heading discussion-heading">
        <div><p className="eyebrow">Командная работа</p><h2>Обсуждения</h2></div>
        <details className="notification-menu"><summary aria-label="Уведомления">🔔{notifications.unread_count > 0 && <b>{notifications.unread_count}</b>}</summary><div>{unreadNotifications.length === 0 ? <p>Новых уведомлений нет</p> : <><button className="notification-read-all" type="button" onClick={() => { void markAllNotificationsRead(); }}>✓ Прочитать всё</button>{unreadNotifications.slice(0, 20).map((item) => <button key={item.id} onClick={() => { void openNotification(item); }}><strong>{item.actor_name || "Система"}</strong><span>{item.kind === "media.comment.mention" ? "упомянул(а) вас в комментарии к фото" : item.kind === "media.comment" ? "добавил(а) комментарий к фото" : item.kind === "message.reply" ? "ответил(а) на ваше сообщение" : item.kind === "message.mention" ? "упомянул(а) вас" : item.kind === "discussion.created" ? "создал(а) обсуждение" : "написал(а) сообщение"}</span></button>)}</>}</div></details>
      </div>
      <div className="discussion-tabs" role="tablist" aria-label="Разделы обсуждений"><button type="button" role="tab" aria-selected={discussionTab === "chats"} className={discussionTab === "chats" ? "active" : ""} onClick={() => setDiscussionTab("chats")}>Чаты <small>{chatCount}</small></button><button type="button" role="tab" aria-selected={discussionTab === "comments"} className={discussionTab === "comments" ? "active" : ""} onClick={() => setDiscussionTab("comments")}>Комментарии <small>{commentTopicCount}</small></button><button type="button" role="tab" aria-selected={discussionTab === "private_comments"} className={discussionTab === "private_comments" ? "active" : ""} onClick={() => setDiscussionTab("private_comments")}>Приватные <small>{privateCommentCount}</small></button></div>
      {discussionTab !== "chats" && <div className="comment-index-tools"><input type="search" value={commentTopicSearch} placeholder="Найти комментарий, клиента или серию" onChange={(event) => setCommentTopicSearch(event.target.value)} />{discussionTab === "comments" && <div className="comment-feed-filter" aria-label="Фильтр комментариев"><button type="button" className={commentFilter === "all" ? "active" : ""} onClick={() => setCommentFilter("all")}>Все</button><button type="button" className={commentFilter === "mentions" ? "active" : ""} onClick={() => setCommentFilter("mentions")}>Упомянули меня</button></div>}</div>}
      <div className="discussion-summary-line"><span>Непрочитанных: <strong>{totalUnread}</strong></span>{firstUnreadId && <button onClick={() => document.getElementById(`discussion-message-${firstUnreadId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>К первому непрочитанному</button>}</div>
      <div className="discussion-tools"><button type="button" onClick={() => { void enableNotifications(); }}>🔔 Включить уведомления</button></div>
      <details className="discussion-create" ref={createDiscussionDetails}>
        <summary>＋ Новый чат</summary>
        <form onSubmit={createDiscussion}>
          <label>Название<input name="title" required minLength={2} maxLength={160} placeholder="Например, Контент на неделю" /></label>
          {selectedMedia.length > 0 && <p className="create-chat-attachment">▧ Материал будет автоматически добавлен в новый чат</p>}
          <fieldset><legend>Участники</legend>{participants.filter((item) => item.id !== session.user.id).map((item) => <label key={item.id}><input type="checkbox" name="member_ids" value={item.id} />{item.display_name}</label>)}</fieldset>
          <button className="primary" disabled={busy}>Создать чат</button>
        </form>
      </details>
      <div className="discussion-layout">
        <aside className="discussion-list" aria-label="Список чатов">
          {visibleDiscussions.map((item) => <button key={item.id} className={activeId === item.id ? "active" : ""} onClick={() => { void openDiscussion(item); }}><span>{item.kind === "general" ? "👥" : item.kind === "batch" ? "💬" : "◌"}</span><div><strong>{item.title}</strong><small>{item.last_message || item.client_name || "Сообщений пока нет"}</small></div>{item.mentioned_me && discussionTab === "comments" && <i title="Вас упомянули">@</i>}{item.unread_count > 0 && <b>{item.unread_count}</b>}</button>)}
        </aside>
        <div className="discussion-chat">
          {activeDiscussion ? <>
            <header className="discussion-chat-header"><div><strong>{activeDiscussion.title}</strong>{activeDiscussion.client_name && <small>{activeDiscussion.client_name}</small>}</div><div className="discussion-header-actions"><span>{activeDiscussion.member_ids.length} участ.</span>{activeDiscussion.can_delete && <button type="button" disabled={busy} onClick={() => { void deleteDiscussion(); }}>Удалить чат</button>}</div></header>
            <form className="discussion-search" onSubmit={(event) => { event.preventDefault(); void loadMessages(activeId, false); }}>
              <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Поиск по тексту" aria-label="Поиск по тексту" />
              <input value={searchClient} onChange={(event) => setSearchClient(event.target.value)} placeholder="Клиент" aria-label="Поиск по клиенту" />
              <select value={searchAuthor} onChange={(event) => setSearchAuthor(event.target.value)} aria-label="Поиск по автору"><option value="">Все авторы</option>{participants.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select>
              {activeDiscussion.batch_id && <label className="batch-search-toggle"><input type="checkbox" checked={onlyCurrentBatch} onChange={(event) => setOnlyCurrentBatch(event.target.checked)} />Эта серия</label>}
              <button>Найти</button>
            </form>
            <div className="discussion-messages">
              {messages.length === 0 && <p className="discussion-empty">Здесь пока нет сообщений.</p>}
              {messages.map((item) => <article id={`discussion-message-${item.id}`} key={item.id} className={`${item.author_id === session.user.id ? "own" : ""} ${item.id === firstUnreadId ? "first-unread" : ""}`}>
                <div className="message-meta"><strong>{item.author_name}</strong><time>{new Date(item.created_at).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</time></div>
                {item.reply_to && <button className="reply-preview" onClick={() => document.getElementById(`discussion-message-${item.reply_to?.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}><strong>{item.reply_to.author_name}</strong><span>{item.reply_to.body || "Медиа"}</span></button>}
                {item.body && <p>{item.body}</p>}
                {item.batch_id && <span className="batch-link">🔗 Ссылка на серию</span>}
                {item.attachments.length > 0 && <div className="message-attachments">{item.attachments.map((attachment) => <button type="button" key={attachment.media_id} onClick={() => setDiscussionPreview(attachment)} aria-label={`Открыть ${attachment.original_name}`}><img src={attachment.thumbnail_url} alt={attachment.original_name} loading="lazy" />{attachment.media_type === "video" && <span>▶</span>}</button>)}</div>}
                <div className="message-actions"><button onClick={() => setReplyTo(item)}>↩ Ответить</button><button className={item.liked_by_me ? "active" : ""} onClick={() => { void toggleLike(item); }}>♥ {item.like_count || ""}</button>{["👍", "❤️", "🔥", "👏"].map((emoji) => <button key={emoji} className={item.my_reactions.includes(emoji) ? "active" : ""} onClick={() => { void toggleReaction(item, emoji); }}>{emoji}{item.reactions[emoji] ? ` ${item.reactions[emoji]}` : ""}</button>)}</div>
              </article>)}
            </div>
            <form className="message-composer" onSubmit={sendMessage}>
              {replyTo && <div className="composer-context"><span>Ответ для {replyTo.author_name}: {replyTo.body || "медиа"}</span><button type="button" onClick={() => setReplyTo(null)}>×</button></div>}
              {(selectedMedia.length > 0 || linkedBatchId) && <div className="composer-context"><span>{selectedMedia.length > 0 ? `Прикреплено: ${selectedMedia.length}` : ""}{linkedBatchId ? " · ссылка на серию" : ""}</span><button type="button" onClick={() => { setSelectedMedia([]); setLinkedBatchId(null); }}>×</button></div>}
              <div className="composer-input">
                {mentionOptions.length > 0 && <div className="mention-suggestions" role="listbox" aria-label="Выбрать пользователя">{mentionOptions.map((item) => <button type="button" role="option" key={item.id} onClick={() => insertMention(item.display_name)}><span>{item.display_name.slice(0, 1).toLocaleUpperCase("ru-RU")}</span><strong>{item.display_name}</strong></button>)}</div>}
                <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={8000} rows={3} placeholder="Сообщение… Введите @ для выбора пользователя" />
              </div>
              <div><button type="button" className="quiet" onClick={() => { void openLibrary(); }}>▧ Из медиатеки</button><button className="primary" disabled={busy || (!body.trim() && selectedMedia.length === 0 && !linkedBatchId)}>{busy ? "Отправляем…" : "Отправить"}</button></div>
            </form>
          </> : <p className="discussion-empty">Выберите чат.</p>}
        </div>
      </div>
      {message && <p className="form-message">{message}</p>}
      {libraryOpen && <div className="move-overlay" role="dialog" aria-modal="true" aria-label="Медиатека" onClick={() => setLibraryOpen(false)}><div className="move-dialog discussion-library" onClick={(event) => event.stopPropagation()}><header><h2>Выбрать из медиатеки</h2><button onClick={() => setLibraryOpen(false)}>×</button></header><p>Файлы не копируются — в чат добавляется безопасная ссылка.</p><div className="discussion-library-grid">{library.map((item) => <article key={item.media_id} className={selectedMedia.includes(item.media_id) ? "selected" : ""}><button onClick={() => setSelectedMedia((current) => current.includes(item.media_id) ? current.filter((id) => id !== item.media_id) : [...current, item.media_id])}><img src={item.thumbnail_url} alt="" loading="lazy" />{item.media_type === "video" && <span>▶</span>}</button>{item.batch_id && <button className={linkedBatchId === item.batch_id ? "active" : ""} onClick={() => setLinkedBatchId(linkedBatchId === item.batch_id ? null : item.batch_id)}>🔗 Серия</button>}</article>)}</div><button className="primary" onClick={() => setLibraryOpen(false)}>Готово · {selectedMedia.length}</button></div></div>}
      {discussionPreview && <div className="discussion-media-preview" role="dialog" aria-modal="true" aria-label={discussionPreview.original_name} onClick={() => setDiscussionPreview(null)}><div onClick={(event) => event.stopPropagation()}><button className="preview-close" onClick={() => setDiscussionPreview(null)} aria-label="Закрыть">×</button>{discussionPreview.media_type === "video" ? <video src={discussionPreview.preview_url} controls autoPlay playsInline /> : <img src={discussionPreview.preview_url} alt={discussionPreview.original_name} />}</div></div>}
    </section>
  );
}

function AccountPanel({ session }: { session: Session }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const newPassword = String(form.get("new_password") ?? "");
    if (newPassword !== form.get("confirm_password")) {
      setMessage("Новые пароли не совпадают");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await api<void>("/auth/password", {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({
          current_password: form.get("current_password"),
          new_password: newPassword,
        }),
      });
      formElement.reset();
      setMessage("Пароль изменён. Текущий вход сохранён, остальные сеансы закрыты.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось изменить пароль");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-panel">
      <details>
        <summary>Сменить пароль для входа</summary>
        <form className="password-form" onSubmit={changePassword}>
          <label>Текущий пароль<input name="current_password" type="password" required autoComplete="current-password" /></label>
          <label>Новый пароль<input name="new_password" type="password" required minLength={10} autoComplete="new-password" /></label>
          <label>Повторите новый пароль<input name="confirm_password" type="password" required minLength={10} autoComplete="new-password" /></label>
          <button className="primary" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить новый пароль"}</button>
          {message && <p className="form-message" aria-live="polite">{message}</p>}
        </form>
      </details>
    </section>
  );
}

function AdminPanel({ session }: { session: Session }) {
  const [users, setUsers] = useState<User[]>([]);
  const [message, setMessage] = useState("");
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [permissionsUserId, setPermissionsUserId] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<"users" | "integrations">("users");

  async function loadUsers() {
    setUsers(await api<User[]>("/users"));
  }

  useEffect(() => {
    void api<User[]>("/users").then(setUsers).catch(() => setMessage("Не удалось загрузить пользователей"));
  }, []);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api<User>("/users", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({
          display_name: form.get("display_name"),
          login: form.get("login"),
          password: form.get("password"),
          role: form.get("role"),
        }),
      });
      formElement.reset();
      setMessage("Учётная запись создана");
      await loadUsers();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Ошибка");
    }
  }

  async function toggleActive(user: User) {
    setMessage("");
    try {
      await api<User>(`/users/${user.id}/active`, {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ is_active: !user.is_active }),
      });
      window.dispatchEvent(new Event("violetta-users-changed"));
      await loadUsers();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Ошибка");
    }
  }

  async function updateUser(event: FormEvent<HTMLFormElement>, user: User) {
    event.preventDefault();
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      await api<User>(`/users/${user.id}`, {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({
          display_name: form.get("display_name"),
          login: form.get("login"),
        }),
      });
      setEditingUserId(null);
      setMessage(user.id === session.user.id ? "Данные изменены. Обновите страницу, чтобы увидеть новое имя вверху." : "Имя и логин изменены");
      await loadUsers();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось изменить пользователя");
    }
  }

  async function resetPassword(user: User) {
    const password = window.prompt(`Новый временный пароль для ${user.display_name} (не менее 10 символов):`);
    if (!password) return;
    try {
      await api<void>(`/users/${user.id}/password`, {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ password }),
      });
      setMessage("Пароль изменён, прежние сеансы завершены");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Ошибка");
    }
  }

  async function updatePermissions(event: FormEvent<HTMLFormElement>, user: User) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setMessage("");
    try {
      await api<User>(`/users/${user.id}/permissions`, {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({
          role: form.get("role"),
          can_create_shared_workspaces: form.get("can_create_shared_workspaces") === "on",
          can_create_private_workspaces: form.get("can_create_private_workspaces") === "on",
          can_add_comments: form.get("can_add_comments") === "on",
          can_upload_media: form.get("can_upload_media") === "on",
          can_view_all_calendars: form.get("can_view_all_calendars") === "on",
          can_access_admin: form.get("can_access_admin") === "on",
          can_access_chats: form.get("can_access_chats") === "on",
          can_access_content: form.get("can_access_content") === "on",
          ...(session.user.role === 'owner' ? { can_access_analytics: form.get('can_access_analytics') === 'on' } : {}),
        }),
      });
      setPermissionsUserId(null);
      setMessage("Права пользователя сохранены");
      await loadUsers();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось сохранить права");
    }
  }

  return (
    <section className="admin-panel admin-page-panel">
      <nav className="admin-tabs" aria-label="Разделы админки">
        <button className={adminTab === "users" ? "active" : ""} onClick={() => setAdminTab("users")}>Пользователи</button>
        {(session.user.role === "owner" || session.user.role === "admin") && <button className={adminTab === "integrations" ? "active" : ""} onClick={() => setAdminTab("integrations")}>Интеграции и API</button>}
      </nav>
      {adminTab === "integrations" ? <IntegrationsPanel session={session} /> : <>
        <div className="section-heading"><div><p className="eyebrow">Управление студией</p><h2>Пользователи и права</h2></div><span>{users.length}</span></div>
        <div className="admin-users-content">
        <div className="user-list">
        {users.map((user) => {
          const canManage = user.role === "employee" || (session.user.role === "owner" && user.role === "admin");
          const canEdit = session.user.role === "owner" || user.role === "employee" || user.id === session.user.id;
          const roleName = user.role === "owner" ? "Владелец" : user.role === "admin" ? "Администратор" : "Сотрудник";
          return (
          <div className={`user-row ${user.is_active ? "" : "inactive"} ${permissionsUserId === user.id ? "permissions-open" : ""}`} key={user.id}>
            {editingUserId === user.id ? <form className="user-edit-form" onSubmit={(event) => { void updateUser(event, user); }}>
              <label>Имя<input name="display_name" defaultValue={user.display_name} required minLength={2} /></label>
              <label>Логин<input name="login" defaultValue={user.login} required minLength={3} pattern="[a-zA-Z0-9._-]+" /></label>
              <div className="user-edit-actions"><button className="primary" type="submit">Сохранить</button><button className="quiet" type="button" onClick={() => setEditingUserId(null)}>Отмена</button></div>
            </form> : <>
              <div><strong>{user.display_name}</strong><small>@{user.login}</small></div>
              <div className="user-controls"><span className={`badge ${user.role}`}>{roleName}</span>{canEdit && <button onClick={() => setEditingUserId(user.id)}>Изменить</button>}{canManage && <><button onClick={() => setPermissionsUserId(permissionsUserId === user.id ? null : user.id)}>Права</button><button onClick={() => { void resetPassword(user); }}>Пароль</button><button onClick={() => { void toggleActive(user); }}>{user.is_active ? "Отключить" : "Включить"}</button></>}</div>
            </>}
            {permissionsUserId === user.id && <form className="permissions-form" onSubmit={(event) => { void updatePermissions(event, user); }}>
              {session.user.role === "owner" ? <label>Роль<select name="role" defaultValue={user.role}><option value="employee">Сотрудник</option><option value="admin">Администратор</option></select></label> : <input type="hidden" name="role" value={user.role} />}
              <fieldset><legend>Права пользователя</legend>
                <label><input type="checkbox" name="can_create_shared_workspaces" defaultChecked={user.can_create_shared_workspaces} />Создавать общие папки</label>
                <label><input type="checkbox" name="can_create_private_workspaces" defaultChecked={user.can_create_private_workspaces} />Создавать приватные папки</label>
                <label><input type="checkbox" name="can_add_comments" defaultChecked={user.can_add_comments} />Оставлять комментарии</label>
                <label><input type="checkbox" name="can_upload_media" defaultChecked={user.can_upload_media} />Добавлять фото и видео</label>
                <label><input type="checkbox" name="can_view_all_calendars" defaultChecked={user.can_view_all_calendars} />Просматривать все календари</label>
                <label><input type="checkbox" name="can_access_admin" defaultChecked={user.can_access_admin} />Доступ к админке</label>
                <label><input type="checkbox" name="can_access_chats" defaultChecked={user.can_access_chats} />Доступ к чатам</label>
                <label><input type="checkbox" name="can_access_content" defaultChecked={user.can_access_content} />Доступ к контенту</label>
                {session.user.role === 'owner' && <label><input type="checkbox" name="can_access_analytics" defaultChecked={user.can_access_analytics} />Доступ к аналитике</label>}
              </fieldset>
              <div className="user-edit-actions"><button className="primary" type="submit">Сохранить права</button><button className="quiet" type="button" onClick={() => setPermissionsUserId(null)}>Отмена</button></div>
            </form>}
          </div>
        );})}
      </div>
        <details className="add-user-details">
        <summary>Добавить пользователя</summary>
        <form className="create-form" onSubmit={createUser}>
          <label>Имя<input name="display_name" required minLength={2} /></label>
          <label>Логин<input name="login" required minLength={3} pattern="[a-zA-Z0-9._-]+" /></label>
          <label>Временный пароль<input name="password" type="password" required minLength={10} autoComplete="new-password" /></label>
          <label>Роль<select name="role"><option value="employee">Сотрудник</option>{session.user.role === "owner" && <option value="admin">Администратор</option>}</select></label>
          <button className="primary">Создать</button>
          {message && <p className="form-message">{message}</p>}
        </form>
        </details>
        </div>
      </>}
    </section>
  );
}

function TelegramStoryConnection({ session, configured, onChange }: { session: Session; configured: boolean; onChange: () => void }) {
  const [attempt, setAttempt] = useState<{ attempt_id: string; status: string; qr?: string | null; message?: string | null } | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!attempt || !['waiting', 'checking'].includes(attempt.status)) return;
    const timer = window.setInterval(() => {
      void api<{ status: string; qr?: string | null; message?: string | null }>(`/integrations/telegram-story/status/${attempt.attempt_id}`).then((next) => {
        setAttempt((current) => current?.attempt_id === attempt.attempt_id ? { ...current, ...next } : current);
        if (next.status === 'connected') onChange();
      }).catch(() => setError('Не удалось проверить подключение.'));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [attempt?.attempt_id, attempt?.status]);
  async function start() {
    setBusy(true); setError(''); setPassword('');
    try { setAttempt(await api('/integrations/telegram-story/start', { method: 'POST', headers: { 'X-CSRF-Token': session.csrf_token } })); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function sendPassword() {
    if (!attempt || !password) return;
    setBusy(true); setError('');
    try { await api(`/integrations/telegram-story/password/${attempt.attempt_id}`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrf_token }, body: JSON.stringify({ password }) }); setPassword(''); setAttempt({ ...attempt, status: 'checking', qr: null }); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function disconnect() {
    if (!window.confirm('Отключить сервер от аккаунта Telegram? Также можно завершить сеанс в Telegram: Настройки → Устройства.')) return;
    setBusy(true); setError('');
    try { await api('/integrations/telegram-story/disconnect', { method: 'POST', headers: { 'X-CSRF-Token': session.csrf_token } }); setAttempt(null); onChange(); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  return <div className="telegram-story-connection">
    <p><strong>Истории Telegram-канала</strong> · {configured ? 'аккаунт подключён' : 'аккаунт не подключён'}</p>
    <small>Подключите аккаунт администратора канала. Сервер получит доступ к этому аккаунту Telegram; его можно отключить в любое время.</small>
    <div className="content-form-actions"><button type="button" disabled={busy} onClick={() => void start()}>{configured ? 'Подключить другой аккаунт' : 'Подключить аккаунт по QR'}</button>{configured && <button type="button" disabled={busy} onClick={() => void disconnect()}>Отключить</button>}</div>
    {attempt?.qr && attempt.status === 'waiting' && <><img src={attempt.qr} width={240} height={240} alt="QR-код для входа в Telegram" /><p>В Telegram на телефоне откройте «Настройки → Устройства → Подключить устройство» и отсканируйте код.</p></>}
    {attempt?.message && <p role="status">{attempt.message}</p>}
    {attempt?.status === 'password' && <><label>Пароль двухэтапной защиты Telegram<input type="password" value={password} autoComplete="off" onChange={(event) => setPassword(event.target.value)} /></label><button type="button" disabled={busy || !password} onClick={() => void sendPassword()}>Подтвердить вход</button></>}
    {error && <p className="error">{error}</p>}
  </div>;
}

function MaxStoryConnection({ session, configured, onChange }: { session: Session; configured: boolean; onChange: () => void }) {
  const [attempt, setAttempt] = useState<{attempt_id: string; status: string; message?: string; qr_image?: string | null} | null>(null);
  const [phone, setPhone] = useState(''); const [answer, setAnswer] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!attempt || !['connecting', 'checking', 'qr'].includes(attempt.status)) return;
    const timer = window.setInterval(() => { void api<{status:string; message?:string; qr_image?:string | null}>(`/integrations/max-story/status/${attempt.attempt_id}`).then(next => { setAttempt(current => current?.attempt_id === attempt.attempt_id ? {...current,...next} : current); if (next.status === 'connected' || next.status === 'error') setAnswer(''); if (next.status === 'connected') onChange(); }).catch(() => setError('Не удалось получить состояние подключения.')); }, 1500);
    return () => window.clearInterval(timer);
  }, [attempt?.attempt_id, attempt?.status]);
  async function start() { setBusy(true); setError(''); setAnswer(''); try { setAttempt(await api('/integrations/max-story/start', {method:'POST', headers:{'X-CSRF-Token':session.csrf_token}, body:JSON.stringify({phone})})); setPhone(''); } catch(e) {setError((e as Error).message);} finally {setBusy(false);} }
  async function startQr() {setBusy(true); setError(''); setAnswer(''); try {setAttempt(await api('/integrations/max-story/start-qr', {method:'POST',headers:{'X-CSRF-Token':session.csrf_token}}));} catch(e) {setError((e as Error).message);} finally {setBusy(false);} }
  async function sendAnswer() { if (!attempt) return; setBusy(true); setError(''); try {await api(`/integrations/max-story/answer/${attempt.attempt_id}`, {method:'POST',headers:{'X-CSRF-Token':session.csrf_token},body:JSON.stringify({value:answer})}); setAnswer(''); setAttempt({...attempt,status:'checking'});} catch(e) {setError((e as Error).message);} finally {setBusy(false);} }
  async function disconnect() {if(!window.confirm('Отключить аккаунт MAX от сервера?')) return; setBusy(true); try {await api('/integrations/max-story/disconnect',{method:'POST',headers:{'X-CSRF-Token':session.csrf_token}}); setAttempt(null); onChange();} catch(e) {setError((e as Error).message);} finally {setBusy(false);} }
  return <div className="max-story-connection"><p><strong>Истории аккаунта MAX</strong> · {configured ? 'аккаунт подключён' : 'не подключён'}</p><small>Истории публикуются от подключённого аккаунта студии, а не от имени сообщества. Сервер получает доступ к аккаунту MAX.</small><button type="button" disabled={busy} onClick={()=>void startQr()}>Подключить по QR-коду</button>{attempt?.status === 'qr' && attempt.qr_image && <img src={attempt.qr_image} alt="QR-код подключения MAX" style={{display:'block',width:240,maxWidth:'100%'}} />}<label>Номер аккаунта студии<input type="tel" autoComplete="off" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+7…" /></label><button type="button" disabled={busy || !phone} onClick={()=>void start()}>Подключить аккаунт</button>{configured && <button type="button" disabled={busy} onClick={()=>void disconnect()}>Отключить</button>}{attempt?.message && <p role="status">{attempt.message}</p>}{attempt && ['qr','code','password'].includes(attempt.status) && <><label>{attempt.status === 'code' ? 'Код из MAX' : 'Пароль двухэтапной защиты MAX'}<input type="password" value={answer} autoComplete="off" onChange={e=>setAnswer(e.target.value)} /></label>{attempt.status === 'qr' && <small>Сначала отсканируйте QR-код; если MAX запросит пароль, нажмите кнопку подтверждения.</small>}<button type="button" disabled={busy || !answer || attempt.status === 'qr'} onClick={()=>void sendAnswer()}>Подтвердить</button></>}{error && <p className="error">{error}</p>}</div>;
}

function IntegrationsPanel({ session }: { session: Session }) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setStatus(await api<IntegrationStatus>("/integrations"));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось загрузить настройки интеграций");
    }
  }

  useEffect(() => { void load(); }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    setMessage("");
    try {
      const next = await api<IntegrationStatus>("/integrations", {
        method: "PUT",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({
          openai_api_key: form.get("openai_api_key") || null,
          openai_model: form.get("openai_model") || null,
          openai_analytics_model: form.get("openai_analytics_model") || null,
          openai_image_model: form.get("openai_image_model") || null,
          telegram_bot_token: form.get("telegram_bot_token") || null,
          telegram_channel: form.get("telegram_channel") || null,
          telegram_api_id: form.get("telegram_api_id") || null,
          telegram_api_hash: form.get("telegram_api_hash") || null,
          max_bot_token: form.get("max_bot_token") || null,
          max_channel_id: form.get("max_channel_id") || null,
          instagram_access_token: form.get("instagram_access_token") || null,
          instagram_analytics_access_token: form.get("instagram_analytics_access_token") || null,
          instagram_account_id: form.get("instagram_account_id") || null,
          threads_access_token: form.get("threads_access_token") || null,
          vk_user_token: form.get("vk_user_token") || null,
          vk_analytics_token: form.get("vk_analytics_token") || null,
          vk_group_id: form.get("vk_group_id") || null,
        }),
      });
      setStatus(next);
      formElement.reset();
      setMessage("Настройки сохранены. Секреты не выводятся и остаются только на сервере.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Не удалось сохранить настройки");
    } finally {
      setSaving(false);
    }
  }

  return <div className="integrations-panel">
    <div className="section-heading"><div><p className="eyebrow">Защищённые подключения</p><h2>Интеграции и API</h2><p>Доступ только владельцу и администраторам. Поля ключей всегда пустые: уже сохранённый ключ нельзя увидеть или скопировать через сайт.</p></div></div>
    <form className="integrations-form" onSubmit={save} key={JSON.stringify(status)}>
      <fieldset><legend>OpenAI — агент контента</legend><span className={status?.openai.configured ? "integration-status ready" : "integration-status"}>{status?.openai.configured ? "Ключ подключён" : "Ключ не задан"}</span>
        <label>Новый API-ключ<input name="openai_api_key" type="password" autoComplete="new-password" placeholder="Оставьте пустым — ключ не изменится" /></label>
        <label>Модель для текста<input name="openai_model" defaultValue={status?.openai.fields.model || "gpt-6-luna"} placeholder="gpt-6-luna" /></label>
        <label>Модель рекомендаций аналитики<input name="openai_analytics_model" defaultValue={status?.openai.fields.analytics_model || "gpt-6-astra"} placeholder="gpt-6-astra" /></label>
        <label>Модель для баннеров<input name="openai_image_model" defaultValue={status?.openai.fields.image_model || "gpt-image-2.5-sunburst"} placeholder="gpt-image-2.5-sunburst" /></label>
      </fieldset>
      <fieldset><legend>Telegram</legend><span className={status?.telegram.configured ? "integration-status ready" : "integration-status"}>{status?.telegram.configured ? "Подключено" : "Не подключено"}</span>
        <label>Токен бота<input name="telegram_bot_token" type="password" autoComplete="new-password" placeholder="Оставьте пустым — токен не изменится" /></label>
        <label>Канал или chat_id<input name="telegram_channel" defaultValue={status?.telegram.fields.channel} placeholder="@violettastudiya" /></label>
        <label>API ID приложения Telegram<input name="telegram_api_id" inputMode="numeric" defaultValue={status?.telegram.fields.api_id || ""} /></label>
        <label>API hash приложения Telegram<input name="telegram_api_hash" type="password" autoComplete="new-password" placeholder="Оставьте пустым — ключ не изменится" /></label>
        <small>Для настройки историй канала. Сохранение ключей само по себе не включает публикацию историй.</small>
        <TelegramStoryConnection session={session} configured={status?.telegram.fields.story_session_configured === 'true'} onChange={() => void load()} />
      </fieldset>
      <fieldset><legend>MAX</legend><span className={status?.max.configured ? "integration-status ready" : "integration-status"}>{status?.max.configured ? "Ключ сохранён" : "Не подключено"}</span>
        <label>Токен бота / API-ключ<input name="max_bot_token" type="password" autoComplete="new-password" placeholder="Оставьте пустым — ключ не изменится" /></label>
        <label>Канал или идентификатор<input name="max_channel_id" defaultValue={status?.max.fields.channel_id} /></label><MaxStoryConnection session={session} configured={status?.max.fields.story_session_configured === 'true'} onChange={() => void load()} />
      </fieldset>
      <fieldset><legend>Instagram / Meta</legend><span className={status?.instagram.configured ? "integration-status ready" : "integration-status"}>{status?.instagram.configured ? "Ключ сохранён" : "Не подключено"}</span>
        <label>Долгоживущий access token<input name="instagram_access_token" type="password" autoComplete="new-password" placeholder="Оставьте пустым — токен не изменится" /></label>
        <label>Отдельный маркер аналитики Instagram<input name="instagram_analytics_access_token" type="password" autoComplete="new-password" placeholder="Не меняет маркер публикаций" /></label>
        <label>ID Instagram business account<input name="instagram_account_id" defaultValue={status?.instagram.fields.account_id} /></label>
      </fieldset>
      <fieldset><legend>Threads</legend><span className={status?.threads?.configured ? "integration-status ready" : "integration-status"}>{status?.threads?.configured ? "Ключ сохранён" : "Не подключено"}</span><label>Отдельный токен Threads<input name="threads_access_token" type="password" autoComplete="new-password" placeholder="Оставьте пустым — токен не изменится" /></label><small>Для публикаций необходим отдельный токен Threads с разрешением на публикацию.</small></fieldset>
      <fieldset><legend>ВКонтакте — стена сообщества</legend><span className={status?.vk?.configured ? "integration-status ready" : "integration-status"}>{status?.vk?.configured ? "Реквизиты сохранены" : "Не настроено"}</span>
        <label>Числовой ID сообщества<input name="vk_group_id" inputMode="numeric" defaultValue={status?.vk?.fields.group_id || ""} placeholder="Например, 123456789" /></label>
        <label>Токен для публикаций<input name="vk_user_token" type="password" autoComplete="new-password" placeholder="Оставьте пустым — токен не изменится" /></label>
        <label>Пользовательский токен VK для аналитики<input name="vk_analytics_token" type="password" autoComplete="new-password" placeholder="Оставьте пустым — токен не изменится" /></label><small>Отдельный токен администратора. Ключ публикаций остаётся прежним. Сохранён: {status?.vk?.fields.analytics_token_configured === "true" ? "да" : "нет"}.</small>
        <small>Нужен токен администратора сообщества с правами на стену и необходимые медиа. Поддерживаются посты на стене сообщества.</small>
      </fieldset>
      <button className="primary" disabled={saving}>{saving ? "Сохраняем…" : "Сохранить интеграции"}</button>
      {message && <p className="form-message" aria-live="polite">{message}</p>}
    </form>
  </div>;
}

function signalNewMessage() {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.setValueAtTime(880, context.currentTime);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.3);
    }
    navigator.vibrate?.([160, 80, 160]);
  } catch {
    // Sound and vibration are optional browser capabilities.
  }
}

function HeaderChatButton({ onOpen }: { onOpen: () => void }) {
  const [unread, setUnread] = useState(0);
  const previousUnread = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api<DiscussionSummary[]>("/discussions").then((items) => {
        const nextUnread = items.reduce((sum, item) => sum + item.unread_count, 0);
        if (!active) return;
        setUnread(nextUnread);
        const badgeNavigator = navigator as Navigator & { setAppBadge?: (contents?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
        if (nextUnread > 0) void badgeNavigator.setAppBadge?.(nextUnread);
        else void badgeNavigator.clearAppBadge?.();
        if (
          previousUnread.current !== null
          && nextUnread > previousUnread.current
          && localStorage.getItem("vita29-notifications") === "enabled"
        ) {
          signalNewMessage();
          if (Notification.permission === "granted" && "serviceWorker" in navigator) {
            void navigator.serviceWorker.ready.then((registration) => registration.showNotification("VIOLETTA — новое сообщение", {
              body: "В ваших чатах появилось новое сообщение",
              icon: "/icon-192.png",
              badge: "/icon-192.png",
              tag: "vita29-chat-message",
            }));
          }
        }
        previousUnread.current = nextUnread;
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return <button className="header-chat" onClick={onOpen}><span aria-hidden="true">💬</span><b>Чаты</b>{unread > 0 && <i>{unread > 99 ? "99+" : unread}</i>}</button>;
}

const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  draft: "Тема · черновик",
  review: "Тема на согласовании",
  approved: "Тема утверждена",
  generating: "Агент готовит материалы",
  ready: "Готово к публикации",
  scheduled: "Запланирован",
  published: "Опубликован",
  failed: "Ошибка",
};
const CONTENT_PLATFORM_LABELS: Record<ContentPlatform, string> = {
  telegram: "Telegram",
  max: "MAX",
  instagram: "Instagram",
  vk: "ВКонтакте",
  threads: "Threads",
};

function mondayFor(value: Date) {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  const day = next.getDay() || 7;
  next.setDate(next.getDate() - day + 1);
  return next;
}

function dateInputValue(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateTimeLocalValue(value: Date) {
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${dateInputValue(value)}T${hours}:${minutes}`;
}

function nextContentSlot(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 30);
  const remainder = next.getMinutes() % 30;
  if (remainder) next.setMinutes(next.getMinutes() + 30 - remainder);
  return next;
}

function appendDictatedText(current: string, spoken: string) {
  const prefix = current.trim();
  const addition = spoken.replace(/\s+/g, " ").trim();
  if (!addition) return current;
  return prefix + (prefix ? " " : "") + addition;
}

function VoiceInputButton({
  onAppend,
  csrfToken,
  disabled = false,
  compact = false,
}: {
  onAppend: (spoken: string) => void;
  csrfToken: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [notice, setNotice] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);

  function releaseMicrophone() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function clearRecordingTimer() {
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }

  useEffect(() => () => {
    clearRecordingTimer();
    if (recorderRef.current) {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    releaseMicrophone();
  }, []);

  async function sendRecording(blob: Blob, mimeType: string) {
    if (!blob.size) {
      setNotice("Речь не услышана. Попробуйте говорить ближе к микрофону.");
      return;
    }
    setTranscribing(true);
    setNotice("Распознаю речь…");
    try {
      const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
      const form = new FormData();
      form.append("audio", new File([blob], `dictation.${extension}`, { type: mimeType || "audio/webm" }));
      const result = await api<{ text: string }>("/content/transcribe", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: form,
      });
      const spoken = result.text?.replace(/\s+/g, " ").trim();
      if (!spoken) {
        setNotice("Речь не удалось распознать. Попробуйте говорить ближе к микрофону.");
        return;
      }
      onAppend(spoken);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось расшифровать запись. Попробуйте ещё раз.");
    } finally {
      setTranscribing(false);
    }
  }

  async function toggleListening() {
    if (disabled || transcribing) return;
    if (recording) {
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") {
        recorder.stop();
        setNotice("Готовлю запись к расшифровке…");
      }
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setNotice("Этот браузер не поддерживает запись с микрофона. Используйте микрофон на клавиатуре.");
      return;
    }
    setNotice("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
        .find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        clearRecordingTimer();
        setRecording(false);
        releaseMicrophone();
        setNotice("Не удалось записать голос. Закройте другое приложение с микрофоном и повторите.");
      };
      recorder.onstop = () => {
        clearRecordingTimer();
        const recordedMimeType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: recordedMimeType });
        recorderRef.current = null;
        setRecording(false);
        releaseMicrophone();
        void sendRecording(blob, recordedMimeType);
      };
      recorder.start();
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") {
          setNotice("Запись остановлена через 90 секунд. Распознаю речь…");
          recorder.stop();
        }
      }, 90_000);
      setRecording(true);
      setNotice("Говорите. Когда закончите, нажмите «Стоп».");
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      const message = name === "NotAllowedError" || name === "SecurityError"
        ? "Браузер запретил доступ к микрофону. Разрешите его для сайта и повторите."
        : name === "NotFoundError"
          ? "Микрофон не найден. Подключите его и повторите."
          : "Не удалось включить микрофон. Проверьте разрешение и повторите.";
      setNotice(message);
      releaseMicrophone();
    }
  }

  return <span className="voice-input-control">
    <button
      type="button"
      className={"voice-input-button " + (recording ? "listening" : "")}
      aria-pressed={recording}
      disabled={disabled || transcribing}
      onClick={toggleListening}
      title="Надиктовать текст"
    >
      {recording ? "■ Стоп" : transcribing ? "Распознаю…" : compact ? "🎙" : "🎙 Надиктовать"}
    </button>
    {notice && <small className="voice-input-notice">{notice}</small>}
  </span>;
}

type AnalyticsPair = { current: number; previous: number } | null;
type GraphPoint = { time: number; value: number };
type AnalyticsPost = { id: string | number; caption?: string | null; text?: string | null; timestamp?: string | number | null; media_product_type?: string | null; media_type?: string | null; thumbnail_url?: string | null; media_url?: string | null; permalink?: string | null; like_count?: number | null; comments_count?: number | null; views?: number | null; likes?: number | null; insights?: Record<string, number> };
type FollowerChange = {count:number;percent:number|null;baseline_at:string}|null;
type FollowerData = {follower_change?:FollowerChange;follower_history?:GraphPoint[]};
type AnalyticsNetwork = FollowerData & { status: string; message?: string; posts?: AnalyticsPost[]; followers?: number | null; stats?: Record<string, {current:number|null;previous:number|null}>; charts?: Record<string,GraphPoint[]>; posts_truncated?: boolean; posts_status?:string; views_partial?:boolean };
type AnalyticsNote = { id:number; created_at:string; platform:string; days:number; summary:string; evidence:string[]; ideas:string[]; limitations:string; model:string };
type AnalyticsOverview = { telegram: FollowerData & { status: string; message?: string; period_start?: string; period_end?: string; followers?: AnalyticsPair; charts?: Record<string, GraphPoint[]> }; instagram: FollowerData & { status: string; message?: string; followers?: number | null; reach?: Array<{ values?: Array<{ end_time: string; value: number }> }>; reach_partial?: boolean; media?: AnalyticsPost[]; media_truncated?: boolean; stories?: AnalyticsPost[]; stories_status?: string }; max: AnalyticsNetwork; vk: AnalyticsNetwork; threads: AnalyticsNetwork & {views_partial?:boolean} };
function AnalyticsChart({ points, title }: { points: GraphPoint[]; title: string }) {
  const rows = points.filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.value)).sort((a,b)=>a.time-b.time);
  if (!rows.length) return <div className="analytics-empty">За этот период нет данных для графика.</div>;
  const low=Math.min(0,...rows.map(p=>p.value)), high=Math.max(low+1,...rows.map(p=>p.value)), first=rows[0].time, last=rows[rows.length-1].time;
  const x=(t:number)=>58+(last===first?260:(t-first)*520/(last-first)), y=(v:number)=>180-(v-low)*145/(high-low);
  const peaks:GraphPoint[]=[]; for (const p of [...rows].sort((a,b)=>b.value-a.value)) { if (peaks.length<3 && peaks.every(q=>Math.abs(x(p.time)-x(q.time))>60)) peaks.push(p); }
  const date=(t:number)=>new Date(t).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});
  return <div className="analytics-chart"><div className="analytics-chart-head"><strong>{title}</strong></div><svg viewBox="0 0 600 215" role="img" aria-label={title}>
    {[0,1,2,3].map(i=><g key={i}><line x1="58" x2="578" y1={180-i*145/3} y2={180-i*145/3} stroke="#e9ded2"/><text x="52" y={184-i*145/3} textAnchor="end" fontSize="12" fill="#766a61">{Math.round(low+(high-low)*i/3).toLocaleString('ru-RU')}</text></g>)}
    {[0,1,2,3].map(i=><g key={i}><line x1={58+i*520/3} x2={58+i*520/3} y1="35" y2="180" stroke="#f1e8de"/><text x={58+i*520/3} y="203" textAnchor="middle" fontSize="12" fill="#766a61">{date(first+(last-first)*i/3)}</text></g>)}
    <polyline points={rows.map(p=>`${x(p.time)},${y(p.value)}`).join(' ')} fill="none" stroke="#c77b25" strokeWidth="3" strokeLinejoin="round"/>{peaks.map(p=><g key={p.time}><circle cx={x(p.time)} cy={y(p.value)} r="4" fill="#c77b25"/><text x={x(p.time)} y={Math.max(17,y(p.value)-9)} textAnchor="middle" fontSize="12" fill="#80501b">{p.value.toLocaleString('ru-RU')}</text></g>)}
  </svg></div>;
}
function FollowerMetric({ value, change }: {value:number|null|undefined; change?:FollowerChange}) {
 const label=change ? `${change.count>=0?'+':''}${change.count.toLocaleString('ru-RU')} чел. · ${change.percent==null?'—':`${change.percent>=0?'+':''}${change.percent.toLocaleString('ru-RU',{maximumFractionDigits:1})}%`} за период` : 'История за выбранный период ещё накапливается';
 return <div className="analytics-metric"><span>Подписчики сейчас</span><strong>{value==null?'—':value.toLocaleString('ru-RU')}</strong><small className={change?(change.count>=0?'analytics-up':'analytics-down'):''}>{label}</small></div>;
}
function AnalyticsMetric({ title, value, previous, note }: { title: string; value: number | null | undefined; previous?: number | null; note?: string }) {
  const change = value != null && previous != null && previous > 0 ? (value - previous) * 100 / previous : null;
  return <div className="analytics-metric"><span>{title}</span><strong>{value == null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}</strong>{change != null ? <small className={change >= 0 ? 'analytics-up' : 'analytics-down'}>{change >= 0 ? '↑' : '↓'} {Math.abs(change).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}% к предыдущему периоду</small> : <small>{note || 'Нет данных для сравнения'}</small>}</div>;
}
function ContentAnalytics({ session }: { session: Session }) {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [platform, setPlatform] = useState<'telegram' | 'instagram' | 'max' | 'vk' | 'threads'>('telegram');
  const [days, setDays] = useState<7 | 30 | 90>(30); const [format, setFormat] = useState<'all' | 'REELS' | 'FEED' | 'STORY'>('all');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const requestId = useRef(0);
  const [advice, setAdvice] = useState<{summary:string; evidence:string[]; ideas:string[]; limitations:string; model:string}|null>(null); const [adviceBusy,setAdviceBusy]=useState(false); const [adviceError,setAdviceError]=useState('');
  const [notesOpen,setNotesOpen]=useState(false); const [notes,setNotes]=useState<AnalyticsNote[]>([]); const [notesNext,setNotesNext]=useState<number|null>(null); const [notesError,setNotesError]=useState(''); const [notesBusy,setNotesBusy]=useState(false);
  async function loadNotes(offset=0) { setNotesBusy(true); setNotesError(''); try { const result=await api<{items:AnalyticsNote[];next_offset:number|null}>(`/content/analytics/notes?offset=${offset}`); setNotes(current=>offset?[...current,...result.items]:result.items); setNotesNext(result.next_offset); } catch { setNotesError('Не удалось загрузить архив записок'); } finally { setNotesBusy(false); } }
  const adviceKey = useRef(''); useEffect(() => { adviceKey.current = `${platform}:${days}`; setAdvice(null); setAdviceError(''); }, [platform, days]);
  async function getAdvice() { const current=`${platform}:${days}`; adviceKey.current=current; setAdviceBusy(true); setAdviceError(''); try { const result=await api<{summary:string; evidence:string[]; ideas:string[]; limitations:string; model:string}>(`/content/analytics/recommendations?platform=${platform}&days=${days}`, {method:'POST',headers:{'X-CSRF-Token':session.csrf_token}}); if (adviceKey.current===current) setAdvice(result); if (notesOpen) void loadNotes(); } catch(e) { if (adviceKey.current===current) setAdviceError(e instanceof Error ? e.message : 'Не удалось получить рекомендации'); } finally { setAdviceBusy(false); } }
  async function load() { const current = ++requestId.current; setLoading(true); setError(''); try { const result = await api<AnalyticsOverview>(`/content/analytics/overview?days=${days}`); if (current === requestId.current) setData(result); } catch { if (current === requestId.current) setError('Не удалось получить аналитику'); } finally { if (current === requestId.current) setLoading(false); } }
  useEffect(() => { void load(); return () => { requestId.current++; }; }, [days]);
  const now = Date.now(), boundary = now - days * 86400000, prevBoundary = boundary - days * 86400000;
  const within = (points: GraphPoint[], start: number, end: number) => points.filter(p => p.time >= start && p.time < end).sort((a,b) => a.time-b.time);
  const compare = (points: GraphPoint[], mode: 'sum' | 'mean') => { const cur = within(points,boundary,now), prev = within(points,prevBoundary,boundary); const calc=(rows:GraphPoint[]) => !rows.length ? null : rows.reduce((v,p)=>v+p.value,0)/(mode==='mean'?rows.length:1); return { current: calc(cur), previous: cur.length >= days*0.8 && prev.length >= days*0.8 && (mode === 'mean' || cur.length === prev.length) ? calc(prev) : null, chart: cur }; };
  const tg=data?.telegram, ig=data?.instagram;
  const igPoints=(ig?.reach?.[0]?.values || []).map(p=>({time:Date.parse(p.end_time),value:p.value})).filter(p=>Number.isFinite(p.time) && Number.isFinite(p.value));
  const igReach=compare(igPoints,'mean'), tgViews=compare(tg?.charts?.post_views || [],'sum');
  const items = (format === 'STORY' ? ig?.stories || [] : (ig?.media || []).filter(p => format==='all' || p.media_product_type===format));
  const ranked = [...items].sort((a,b)=>(b.insights?.views ?? -1)-(a.insights?.views ?? -1)).slice(0,6);
  const network = platform==='max'||platform==='vk'||platform==='threads' ? data?.[platform] : null;
  const netItems = (network?.posts || []).filter(p=>{ const time=typeof p.timestamp==='number' ? (p.timestamp<1e12?p.timestamp*1000:p.timestamp) : Date.parse(p.timestamp || ''); return Number.isFinite(time) && time>=boundary; });
  return <section className="analytics-dashboard"><div className="analytics-heading"><div><small>СТАТИСТИКА СТУДИИ</small><h2>Аналитика контента</h2><p>Реальные показатели выбранной площадки</p></div><button type="button" disabled={loading} onClick={() => void load()}>{loading ? 'Обновляем…' : '↻ Обновить'}</button></div>
    <button type="button" onClick={()=>{const opening=!notesOpen; setNotesOpen(opening); if(opening) void loadNotes();}}>{notesOpen?'Закрыть архив записок':'Архив аналитических записок'}</button>{notesOpen && <section className="analytics-advice"><h3>Журнал рекомендаций</h3>{notesBusy && <p>Загружаем записки…</p>}{notesError && <p className="error">{notesError}</p>}{!notesBusy && !notes.length && !notesError && <p>Записок пока нет. Новые рекомендации сохраняются автоматически.</p>}{notes.map(note=><article className="analytics-advice-result" key={note.id}><small>№ {note.id} · {new Date(note.created_at).toLocaleString('ru-RU')} · {note.platform.toUpperCase()} · {note.days} дней</small><p><strong>{note.summary}</strong></p><h4>Факты</h4><ul>{note.evidence.map((v,i)=><li key={i}>{v}</li>)}</ul><h4>Идеи</h4><ul>{note.ideas.map((v,i)=><li key={i}>{v}</li>)}</ul><p>{note.limitations}</p></article>)}{notesNext!=null && <button disabled={notesBusy} onClick={()=>void loadNotes(notesNext)}>Показать ещё</button>}</section>}
    <div className="analytics-filters"><div className="analytics-switch">{([['telegram','Telegram'],['instagram','Instagram'],['max','MAX'],['vk','ВКонтакте'],['threads','Threads']] as const).map(([key,label])=><button key={key} className={platform===key?'active':''} onClick={()=>setPlatform(key)}>{label}</button>)}</div><div className="analytics-switch">{([7,30,90] as const).map(n=><button key={n} className={days===n?'active':''} onClick={()=>setDays(n)}>{n} дней</button>)}</div></div>
    {error && <p className="error">{error}</p>}{loading && <p>Получаем данные площадок…</p>}
    {data && platform==='telegram' && <>{tg?.status==='ok' ? <><div className="analytics-metrics"><FollowerMetric value={tg.followers?.current} change={tg.follower_change}/><AnalyticsMetric title="Просмотры постов за период" value={tgViews.current} previous={tgViews.previous}/><AnalyticsMetric title="Истории: просмотры за период" value={compare(tg.charts?.story_views || [],'sum').current} previous={compare(tg.charts?.story_views || [],'sum').previous}/></div><AnalyticsChart points={tgViews.chart} title="Просмотры публикаций по дням"/><p className="analytics-foot">Сравнение — с предыдущими {days} днями, если Telegram предоставил достаточно данных.</p></> : <p>{tg?.message || 'Нет данных Telegram'}</p>}</>}
    {data && platform==='instagram' && <><div className="analytics-metrics"><FollowerMetric value={ig?.followers} change={ig?.follower_change}/><AnalyticsMetric title="Средний дневной охват" value={igReach.current} previous={igReach.previous} note="Нет данных для сравнения"/><AnalyticsMetric title="Публикаций в выборке" value={ig?.media?.length} note="Последние материалы за период"/></div>{ig?.message && <p>{ig.message}</p>}{ig?.reach_partial && <p>Meta вернула данные не за весь запрошенный период.</p>}<AnalyticsChart points={igReach.chart} title="Дневной охват Instagram"/><p className="analytics-foot">Охват — среднее за дни периода, а не сумма уникальных людей за месяц. Сторис доступны, пока Meta их возвращает.</p><div className="analytics-subhead"><h3>Лучшие материалы</h3><div className="analytics-switch">{([['all','Все'],['REELS','Reels'],['FEED','Посты'],['STORY','Сторис']] as const).map(([key,label])=><button key={key} className={format===key?'active':''} onClick={()=>setFormat(key)}>{label}</button>)}</div></div>{ig?.media_truncated && format!=='STORY' && <p className="analytics-foot">Показаны последние 30 материалов из доступной выборки.</p>}<div className="analytics-posts">{ranked.map(p=><article className="analytics-post" key={p.id}>{(p.thumbnail_url || (p.media_type==='IMAGE' ? p.media_url : null)) && <img src={p.thumbnail_url || p.media_url || ''} alt="" loading="lazy"/>}<div><small>{format==='STORY'?'СТОРИС':p.media_product_type==='REELS'?'REELS':'ПОСТ'} · {p.timestamp ? new Date(p.timestamp).toLocaleDateString('ru-RU') : ''}</small><strong>{p.caption?.slice(0,90) || (format==='STORY'?'История':'Материал без подписи')}</strong><p>▶ {p.insights?.views ?? '—'} просмотров · Охват {p.insights?.reach ?? '—'}</p><p>♥ {p.like_count ?? '—'} · Сохранения {p.insights?.saved ?? '—'} · Поделились {p.insights?.shares ?? '—'}</p>{p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer">Открыть публикацию ↗</a>}</div></article>)}</div>{!ranked.length && <div className="analytics-empty">Материалов этого формата за доступный период нет.</div>}</>}
    {data && platform==='threads' && <>{network?.status==='ok' ? <><div className="analytics-metrics"><FollowerMetric value={network.followers} change={network.follower_change}/>{([['views','Просмотры профиля'],['likes','Отметки «Нравится»'],['replies','Ответы'],['reposts','Репосты'],['quotes','Цитирования']] as const).map(([key,label])=><AnalyticsMetric key={key} title={label} value={network.stats?.[key]?.current} previous={network.stats?.[key]?.previous} />)}</div><AnalyticsChart points={network.charts?.views || []} title="Просмотры по дням"/><p className="analytics-foot">Показатели и сравнение — за выбранный и предыдущий период; Meta может возвращать неполные дни. Просмотры отдельных постов накоплены на сегодня.</p>{network.views_partial && <p>Данные за период неполные.</p>}<div className="analytics-posts">{(network.posts || []).map(p=><article className="analytics-post" key={p.id}><div><strong>{p.text?.slice(0,100)||'Публикация'}</strong><p>Просмотры: {p.views ?? '—'} · Отметки «Нравится»: {p.likes ?? '—'}</p>{p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer">Открыть публикацию ↗</a>}</div></article>)}</div>{network.posts_truncated && <p>Показана ограниченная выборка публикаций.</p>}</> : <p>{network?.message || 'Нет данных Threads'}</p>}</>}
    {data && platform==='vk' && (network?.status==='ok'||network?.status==='limited') && <><div className="analytics-metrics"><FollowerMetric value={network.followers} change={network.follower_change}/>{([['reach','Охват за период'],['visitors','Посетители за период'],['views','Просмотры за период'],['subscribed','Новые подписчики'],['unsubscribed','Отписались'],['likes','Отметки «Нравится»'],['comments','Комментарии'],['reposts','Репосты']] as const).map(([key,label])=><AnalyticsMetric key={key} title={label} value={network.stats?.[key]?.current} previous={network.stats?.[key]?.previous} />)}</div><AnalyticsChart points={network.charts?.reach || []} title="Охват по дням"/><p className="analytics-foot">Охват за период — значение VK, а не сумма дневных охватов. Сравнение с предыдущим периодом той же длительности.</p>{network.posts_truncated && <p>Показана ограниченная выборка последних публикаций.</p>}</>}
    {data && platform==='max' && network && <div className="analytics-metrics"><FollowerMetric value={network.followers} change={network.follower_change}/></div>}
    {data && data[platform]?.follower_history && data[platform]!.follower_history!.length>1 && <AnalyticsChart points={data[platform]!.follower_history!} title="Подписчики по дням"/>}
    {data && (platform==='max'||platform==='vk') && <>{network?.message && <p>{network.message}</p>}{(network?.status==='ok'||network?.status==='limited') && network?.posts_status !== 'unavailable' && <><div className="analytics-metrics"><AnalyticsMetric title="Публикаций в выборке" value={netItems.length}/><AnalyticsMetric title="Просмотры этих публикаций сейчас" value={netItems.some(p=>p.views!=null) ? netItems.reduce((n,p)=>n+(p.views ?? 0),0) : null}/></div><p className="analytics-foot">Показаны последние публикации, созданные за выбранный период; их просмотры — накопленные на текущий момент.</p><div className="analytics-posts">{netItems.slice(0,6).map(p=><article className="analytics-post" key={p.id}><div><strong>{p.text?.slice(0,90)||'Публикация'}</strong><p>Просмотры: {p.views ?? 'нет данных'}</p></div></article>)}</div></>}</>}
    <section className="analytics-advice"><div><small>OPENAI · АНАЛИЗ ПО ЗАПРОСУ</small><h3>Идеи для продвижения</h3><p>Модель опирается на доступные цифры и отмечает предположения. Она ничего не публикует.</p></div><button type="button" disabled={adviceBusy || loading} onClick={() => void getAdvice()}>{adviceBusy ? 'Анализируем…' : 'Получить рекомендации'}</button>{adviceError && <p className="error">{adviceError}</p>}{advice && <div className="analytics-advice-result"><strong>{advice.summary}</strong><h4>Что видно по данным</h4><ul>{advice.evidence.map((x,i)=><li key={i}>{x}</li>)}</ul><h4>Что попробовать</h4><ul>{advice.ideas.map((x,i)=><li key={i}>{x}</li>)}</ul><p>{advice.limitations}</p><small>Модель: {advice.model}</small></div>}</section>
  </section>;
}

function ContentPanel({ session, initialMediaIds, onInitialMediaHandled }: { session: Session; initialMediaIds: string[]; onInitialMediaHandled: () => void }) {
  const [weekStart, setWeekStart] = useState(() => mondayFor(new Date()));
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [archiveItems, setArchiveItems] = useState<ContentArchiveEntry[]>([]);
  const [archiveNext, setArchiveNext] = useState<number | null>(null);
  const [archiveTargets, setArchiveTargets] = useState<ContentPlatform[]>([]);
  const [archiveSelected, setArchiveSelected] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<"day" | "week">("day");
  const [planDay, setPlanDay] = useState(false);
  const [planDate, setPlanDate] = useState(() => dateInputValue(new Date()));
  const [startingPlan, setStartingPlan] = useState(false);
  const startPlanOnSubmit = useRef(false);
  const [newContentFormat, setNewContentFormat] = useState<ContentFormat>("post");
  const [newDateAssigned, setNewDateAssigned] = useState(false);
  const [newInstagramSelected, setNewInstagramSelected] = useState(false);
  const [newTelegramSelected, setNewTelegramSelected] = useState(false);
  const [newMaxSelected, setNewMaxSelected] = useState(false);
  const [newMaxFormat, setNewMaxFormat] = useState<PublicationFormat>('post');
  const [newTelegramFormat, setNewTelegramFormat] = useState<PublicationFormat>('post');
  const [newInstagramFormat, setNewInstagramFormat] = useState<PublicationFormat>("post");
  const [newVisualStyle, setNewVisualStyle] = useState<ContentVisualStyle>("auto");
  const [availabilityStaff, setAvailabilityStaff] = useState<AvailabilityStaff[]>([]);
  const [contentLibrary, setContentLibrary] = useState<ContentLibraryMedia[]>([]);
  const [contentLibraryFolders, setContentLibraryFolders] = useState<ContentLibraryWorkspace[]>([]);
  const [contentLibraryWorkspaceId, setContentLibraryWorkspaceId] = useState("");
  const [contentLibrarySearch, setContentLibrarySearch] = useState("");
  const [contentLibraryNextOffset, setContentLibraryNextOffset] = useState<number | null>(null);
  const [contentLibraryLoading, setContentLibraryLoading] = useState(false);
  const [contentLibraryOpen, setContentLibraryOpen] = useState(false);
  const [selectedSourceMedia, setSelectedSourceMedia] = useState<string[]>([]);
  const [sourceImageEdit, setSourceImageEdit] = useState(false);
  const [replacingMediaFor, setReplacingMediaFor] = useState<string | null>(null);
  const [replacementMedia, setReplacementMedia] = useState<string[]>([]);
  const [formatMediaTarget, setFormatMediaTarget] = useState<{itemId: string; publication: ContentPublication} | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newEditorInstruction, setNewEditorInstruction] = useState("");
  const [refinementDialog, setRefinementDialog] = useState<{
    item: ContentItem;
    kind: "visual" | "selection" | "regenerate";
    text: string;
  } | null>(null);
  const [refinementError, setRefinementError] = useState("");
  const [weekEntries, setWeekEntries] = useState<WeeklyContentEntry[]>([
    { day: 0, title: "", content_format: "post", media_limit: 1, visual_style: "auto", platforms: [], platform_formats: {} },
  ]);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setItems(await api<ContentItem[]>(`/content/items?week_start=${dateInputValue(weekStart)}`));
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [weekStart]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") void api<AvailabilityStaff[]>("/content/availability/staff").then(setAvailabilityStaff).catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("violetta-users-changed", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("violetta-users-changed", refresh); };
  }, []);
  useEffect(() => {
    if (!initialMediaIds.length) return;
    setSelectedSourceMedia(initialMediaIds);
    setSourceImageEdit(true);
    setCreating(true);
    setCreateMode("day");
    onInitialMediaHandled();
  }, [initialMediaIds, onInitialMediaHandled]);
  useEffect(() => {
    if (selectedSourceMedia.length === 0) setSourceImageEdit(false);
  }, [selectedSourceMedia.length]);

  async function loadContentLibrary(options: { append?: boolean; workspaceId?: string; search?: string; offset?: number } = {}) {
    const workspaceId = options.workspaceId ?? contentLibraryWorkspaceId;
    const search = options.search ?? contentLibrarySearch;
    const offset = options.offset ?? 0;
    const params = new URLSearchParams({ limit: "60", offset: String(offset) });
    if (workspaceId) params.set("workspace_id", workspaceId);
    if (search.trim()) params.set("search", search.trim());
    setContentLibraryLoading(true);
    try {
      const result = await api<ContentLibraryResult>(`/content/media-library?${params.toString()}`);
      setContentLibrary((current) => options.append ? [...current, ...result.items] : result.items);
      setContentLibraryFolders(result.workspaces);
      setContentLibraryNextOffset(result.next_offset);
    } catch {
      setError("Не удалось открыть разрешённые материалы хранилища");
    } finally {
      setContentLibraryLoading(false);
    }
  }

  async function openContentLibrary() {
    setContentLibraryOpen(true);
    await loadContentLibrary({ workspaceId: contentLibraryWorkspaceId, search: contentLibrarySearch });
  }

  function renderContentLibrary(selected: string[], setSelected: (update: (current: string[]) => string[]) => void, limit: number) {
    return <>
      <div className="content-library-tools">
        <select value={contentLibraryWorkspaceId} onChange={(event) => { const value = event.target.value; setContentLibraryWorkspaceId(value); void loadContentLibrary({ workspaceId: value, search: contentLibrarySearch }); }}>
          <option value="">Все доступные папки</option>
          {contentLibraryFolders.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.kind === "private" ? "🔒 " : ""}{workspace.display_name}</option>)}
        </select>
        <input value={contentLibrarySearch} placeholder="Имя файла или комментарий" onChange={(event) => setContentLibrarySearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadContentLibrary({ workspaceId: contentLibraryWorkspaceId, search: contentLibrarySearch }); } }} />
        <button type="button" className="quiet" onClick={() => void loadContentLibrary({ workspaceId: contentLibraryWorkspaceId, search: contentLibrarySearch })}>Найти</button>
      </div>
      <div className="content-media-library">
        {contentLibraryLoading && contentLibrary.length === 0 ? <p className="muted">Загружаю материалы…</p> : contentLibrary.length === 0 ? <p className="muted">Нет доступных материалов по этому фильтру.</p> : contentLibrary.map((media) => <label key={media.id} className={selected.includes(media.id) ? "selected" : ""}>
          <input type="checkbox" checked={selected.includes(media.id)} onChange={() => setSelected((current) => current.includes(media.id) ? current.filter((id) => id !== media.id) : [...current, media.id].slice(0, limit))} />
          <img src={media.thumbnail_url} alt="" />
          <span>{media.media_type === "video" ? "🎬 Видео" : "Фото"} · {media.workspace_name}{media.content_marked ? " · ✦ контент" : ""}</span>
          {media.comment && <small>{media.comment}</small>}
        </label>)}
      </div>
      {contentLibraryNextOffset !== null && <button type="button" className="quiet content-library-more" disabled={contentLibraryLoading} onClick={() => void loadContentLibrary({ append: true, offset: contentLibraryNextOffset })}>{contentLibraryLoading ? "Загружаю…" : "Показать ещё"}</button>}
    </>;
  }

  function changeWeek(days: number) {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + days);
    setWeekStart(next);
  }

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const platforms = (["telegram", "max", "instagram", "vk", "threads"] as ContentPlatform[]).filter((platform) => form.get(platform) === "on");
    const contentFormat = newContentFormat;
    if (!platforms.length) {
      setError("Выберите хотя бы одну площадку");
      return;
    }
    setError("");
    try {
      const created = await api<ContentItem>("/content/items", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({
          title: contentFormat === "availability"
            ? `${availabilityStaff.find((entry) => entry.staff_id === Number(form.get("availability_staff_id")))?.staff_name || "Мастер"} — свободные окна`
            : String(form.get("title") || ""),
          scheduled_at: new Date(String(form.get("scheduled_at"))).toISOString(),
          publication_date_assigned: newDateAssigned,
          platforms,
          platform_formats: Object.fromEntries(platforms.map((platform) => [platform, platform === "instagram" ? newInstagramFormat : platform === 'telegram' ? newTelegramFormat : platform === 'max' ? newMaxFormat : "post"])),
          media_ids: selectedSourceMedia,
          content_format: contentFormat,
          media_limit: Number(form.get("media_limit") || 1),
          availability_staff_id: contentFormat === "availability" ? Number(form.get("availability_staff_id") || 0) || null : null,
          editor_instruction: String(form.get("editor_instruction") || "").trim() || null,
          visual_edit_requested: sourceImageEdit,
          visual_style: newVisualStyle,
        }),
      });
      setWorkingId(created.id);
      await api<ContentItem>(`/content/items/${created.id}/prepare`, {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      // The API determines whether a campaign visual is requested.  This
      // avoids client-cache and Cyrillic-regex edge cases, and prevents a
      // second paid image-generation call after the server has built it.
      formElement.reset();
      setNewTitle("");
      setNewEditorInstruction("");
      setNewContentFormat("post");
      setNewDateAssigned(false);
      setNewInstagramSelected(false);
      setNewTelegramSelected(false);
      setNewMaxSelected(false); setNewMaxFormat('post');
      setNewTelegramFormat('post');
      setNewInstagramFormat("post");
      setNewVisualStyle("auto");
      setSelectedSourceMedia([]);
      setSourceImageEdit(false);
      setContentLibraryOpen(false);
      setCreating(false);
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
      // When preparation fails (for example because YCLIENTS has no free
      // hour-long slots), the server preserves a failed card with a clear
      // reason. Load it at once so the action never appears to do nothing.
      await load();
    } finally {
      setWorkingId(null);
    }
  }

  async function createWeek(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const readyEntries = weekEntries.filter((entry) => entry.title.trim());
    if (!readyEntries.length) { setError("Добавьте хотя бы одну тему"); return; }
    if (readyEntries.some((entry) => entry.platforms.length === 0)) {
      setError("Выберите хотя бы одну площадку в каждой строке плана");
      return;
    }
    let nextAutomaticSlot = nextContentSlot();
    const itemsForWeek = readyEntries.map((entry, index) => {
      const scheduledAt = planDay ? new Date(`${planDate}T12:00:00`) : new Date(weekStart);
      if (!planDay) scheduledAt.setDate(scheduledAt.getDate() + entry.day);
      scheduledAt.setHours(planDay ? 10 + Math.floor(index / 2) : 10 + (index % 3), planDay && index % 2 ? 30 : 0, 0, 0);
      if (scheduledAt < nextAutomaticSlot) {
        scheduledAt.setTime(nextAutomaticSlot.getTime());
        nextAutomaticSlot = new Date(nextAutomaticSlot.getTime() + 30 * 60 * 1000);
      }
      if (planDay) nextAutomaticSlot = new Date(scheduledAt.getTime() + 30 * 60 * 1000);
      return {
        title: entry.title.trim(),
        scheduled_at: scheduledAt.toISOString(),
        platforms: entry.platforms,
        platform_formats: entry.platform_formats,
        media_ids: [],
        content_format: entry.content_format,
        media_limit: entry.media_limit,
        visual_style: entry.visual_style,
      };
    });
    if (planDay && itemsForWeek.some((item) => dateInputValue(new Date(item.scheduled_at)) !== planDate)) { setError('Выберите будущую дату с достаточным временем для подготовки'); return; }
    setError("");
    try {
      setStartingPlan(true);
      const shouldStart = startPlanOnSubmit.current;
      startPlanOnSubmit.current = false;
      const created = await api<ContentItem[]>("/content/items/bulk", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ items: itemsForWeek }),
      });
      formElement.reset();
      setWeekEntries([{ day: 0, title: "", content_format: "post", media_limit: 1, visual_style: "auto", platforms: [], platform_formats: {} }]);
      setCreating(false);
      await load();
      if (shouldStart) {
        const response = await api<{ results: { id: string; scheduled: boolean; error?: string }[] }>("/content/plan/start", {
          method: "POST", headers: { "X-CSRF-Token": session.csrf_token }, body: JSON.stringify({ item_ids: created.map((item) => item.id) }),
        });
        await load();
        const failed = response.results.filter((entry) => !entry.scheduled);
        if (failed.length) setError(`План сохранён. Запланировано: ${response.results.length - failed.length} из ${response.results.length}. ${failed.map((entry) => `${created.find((item) => item.id === entry.id)?.title || "Публикация"}: ${entry.error || "не удалось запланировать"}`).join("; ")}`);
      }
    } catch (requestError) {
      setError((requestError as Error).message);
      await load();
    } finally { setStartingPlan(false); }
  }

  async function setStatus(item: ContentItem, status: ContentStatus) {
    setError("");
    setWorkingId(item.id);
    try {
      const schedule = status === "scheduled";
      await api<ContentItem>(`/content/items/${item.id}${schedule ? "/schedule" : ""}`, {
        method: schedule ? "POST" : "PATCH",
        headers: { "X-CSRF-Token": session.csrf_token },
        ...(schedule ? {} : { body: JSON.stringify({ status }) }),
      });
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setWorkingId(null);
    }
  }

  async function rollbackToDraft(item: ContentItem) {
    setError("");
    setWorkingId(item.id);
    try {
      // Keep the prepared text and selected media intact.  This is a safe
      // planning undo: it only removes the approval/scheduled state and never
      // publishes or deletes anything.
      await api<ContentItem>(`/content/items/${item.id}/rollback`, {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setWorkingId(null);
    }
  }

  async function publishSelected(item: ContentItem) {
    setError("");
    setWorkingId(item.id);
    try {
      const response = await api<{ results: { platform: ContentPlatform; published: boolean; error?: string }[] }>(`/content/items/${item.id}/publish-selected`, {
        method: "POST", headers: { "X-CSRF-Token": session.csrf_token },
      });
      await load();
      const failures = response.results.filter((entry) => !entry.published);
      if (failures.length) setError(failures.map((entry) => `${CONTENT_PLATFORM_LABELS[entry.platform]}: ${entry.error || "не отправлено"}`).join("; "));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отправить публикацию");
      await load();
    } finally { setWorkingId(null); }
  }

  async function removePlatform(item: ContentItem, publication: ContentPublication) {
    if (!window.confirm(`Убрать ${CONTENT_PLATFORM_LABELS[publication.platform]} из этой публикации?`)) return;
    setError("");
    setWorkingId(item.id);
    try {
      await api<ContentItem>(`/content/items/${item.id}/publications/${publication.platform}?publication_id=${encodeURIComponent(publication.id)}`, { method: "DELETE", headers: { "X-CSRF-Token": session.csrf_token } });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось убрать площадку"); }
    finally { setWorkingId(null); }
  }

  async function confirmNotPublished(item: ContentItem, publication: ContentPublication) {
    if (!window.confirm("Подтверждаете, что проверили площадку и публикации там нет?")) return;
    setError("");
    setWorkingId(item.id);
    try {
      await api<ContentItem>(`/content/items/${item.id}/publications/${publication.platform}/confirm-not-published?publication_id=${encodeURIComponent(publication.id)}`, { method: "POST", headers: { "X-CSRF-Token": session.csrf_token } });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось восстановить статус"); }
    finally { setWorkingId(null); }
  }

  async function remove(item: ContentItem) {
    if (!window.confirm(`Удалить «${item.title}» из плана?`)) return;
    try {
      await api<void>(`/content/items/${item.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function prepare(item: ContentItem) {
    setError("");
    setWorkingId(item.id);
    try {
      await api<ContentItem>(`/content/items/${item.id}/prepare`, {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setWorkingId(null);
    }
  }

  async function openFormatMediaPicker(item: ContentItem, publication: ContentPublication) {
    setError(""); setFormatMediaTarget({itemId: item.id, publication});
    setReplacementMedia(publication.media_ids); setContentLibraryWorkspaceId("");
    await loadContentLibrary({workspaceId: ""});
  }
  async function saveFormatMedia(item: ContentItem, publication: ContentPublication) {
    if (!replacementMedia.length) { setError("Выберите материалы для формата"); return; }
    setWorkingId(item.id); setError("");
    try {
      await api<ContentItem>(`/content/items/${item.id}/publications/${publication.platform}/media?publication_id=${encodeURIComponent(publication.id)}`, {
        method: "PATCH", headers: { "X-CSRF-Token": session.csrf_token }, body: JSON.stringify({ media_ids: replacementMedia }),
      });
      setFormatMediaTarget(null); setReplacementMedia([]); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить материалы"); }
    finally { setWorkingId(null); }
  }

  async function openManualMediaPicker(item: ContentItem) {
    setError("");
    // Keep the original selected material when available. Generated banner IDs
    // live only in a publication and are deliberately not reused as sources.
    setReplacementMedia(item.media_ids.slice(0, item.media_limit));
    setReplacingMediaFor(item.id);
    await loadContentLibrary();
  }

  async function saveManualMediaPicker(item: ContentItem) {
    if (!replacementMedia.length) {
      setError("Выберите хотя бы один фото- или видеоматериал");
      return;
    }
    setError("");
    setWorkingId(item.id);
    try {
      await api<ContentItem>(`/content/items/${item.id}`, {
        method: "PATCH",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ media_ids: replacementMedia, status: "draft" }),
      });
      await api<ContentItem>(`/content/items/${item.id}/prepare`, {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      setReplacingMediaFor(null);
      setReplacementMedia([]);
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setWorkingId(null);
    }
  }

  async function publishTelegram(item: ContentItem) {
    if (!window.confirm("Опубликовать подготовленный материал в Telegram сейчас?")) return;
    setError("");
    setWorkingId(item.id);
    try {
      await api<ContentItem>(`/content/items/${item.id}/publications/telegram`, {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setWorkingId(null);
    }
  }

  async function publishInstagram(item: ContentItem) {
    if (!window.confirm("Опубликовать подготовленный материал в Instagram сейчас? Файл будет временно доступен Meta только на время публикации.")) return;
    setError("");
    setWorkingId(item.id);
    try {
      await api<ContentItem>(`/content/items/${item.id}/publications/instagram`, {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setWorkingId(null);
    }
  }

  async function changeCaption(item: ContentItem, publication: ContentPublication) {
    const next = window.prompt("Измените подпись к публикации", publication.caption || "");
    if (next === null || !next.trim()) return;
    setError("");
    setWorkingId(item.id);
    try {
      await api<ContentItem>(`/content/items/${item.id}/publications/${publication.platform}/caption?publication_id=${encodeURIComponent(publication.id)}`, {
        method: "PATCH",
        headers: { "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify({ caption: next.trim() }),
      });
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setWorkingId(null);
    }
  }

  function openRefinementDialog(item: ContentItem, kind: "visual" | "selection" | "regenerate") {
    setError("");
    setRefinementError("");
    // The dialog starts empty on purpose. It adds a new note to the stored
    // brief instead of inviting the editor to overwrite the original request.
    setRefinementDialog({ item, kind, text: kind === "regenerate" ? item.editor_instruction || "" : "" });
  }

  async function submitRefinement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dialog = refinementDialog;
    if (!dialog) return;
    const next = dialog.text.trim();
    if (dialog.kind !== "regenerate" && next.length < 2) {
      setRefinementError("Добавьте короткое уточнение или надиктуйте его.");
      return;
    }
    setError("");
    setRefinementError("");
    setWorkingId(dialog.item.id);
    try {
      if (dialog.kind === "regenerate") {
        const visualRequest = 'Создать фирменное изображение для публикации.';
        const isReel = dialog.item.publications.some((publication) => publication.platform === 'instagram' && publication.publication_format === 'reel');
        const isStorySeries = dialog.item.media_ids.length > 1 && dialog.item.publications.some((publication) => publication.platform === 'instagram' && publication.publication_format === 'story');
        const instruction = dialog.item.visual_edit_requested || isReel || isStorySeries || next.includes(visualRequest) ? next : [next.slice(0, 1000 - visualRequest.length - 1), visualRequest].filter(Boolean).join('\n');
        await api<ContentItem>(`/content/items/${dialog.item.id}`, { method: 'PATCH', headers: { 'X-CSRF-Token': session.csrf_token }, body: JSON.stringify({ editor_instruction: instruction || null }) });
        await api<ContentItem>(`/content/items/${dialog.item.id}/prepare`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrf_token } });
      } else if (dialog.kind === "visual") {
        await api<ContentItem>("/content/items/" + dialog.item.id + "/visual", {
          method: "POST",
          headers: { "X-CSRF-Token": session.csrf_token },
          body: JSON.stringify({ instruction: next, source_media_ids: dialog.item.media_ids }),
        });
      } else {
        await api<ContentItem>("/content/items/" + dialog.item.id, {
          method: "PATCH",
          headers: { "X-CSRF-Token": session.csrf_token },
          body: JSON.stringify({ editor_instruction: next, append_editor_instruction: true }),
        });
        await api<ContentItem>("/content/items/" + dialog.item.id + "/prepare", {
          method: "POST",
          headers: { "X-CSRF-Token": session.csrf_token },
        });
      }
      setRefinementDialog(null);
      await load();
    } catch (requestError) {
      setRefinementError((requestError as Error).message);
    } finally {
      setWorkingId(null);
    }
  }

  async function changeAvailabilityMaster(item: ContentItem) {
    const choices = availabilityStaff.map((entry) => `${entry.staff_id} — ${entry.staff_name}${entry.specialization ? ` (${entry.specialization})` : ""}`).join("\n");
    const answer = window.prompt(`Введите номер мастера:\n${choices}`, item.availability_staff_id ? String(item.availability_staff_id) : "");
    const staffId = Number(answer);
    if (!answer || !availabilityStaff.some((entry) => entry.staff_id === staffId)) return;
    setWorkingId(item.id); setError("");
    try {
      await api<ContentItem>(`/content/items/${item.id}`, { method: "PATCH", headers: { "X-CSRF-Token": session.csrf_token }, body: JSON.stringify({ availability_staff_id: staffId, status: "draft" }) });
      await prepare({ ...item, status: "draft" });
    } finally { setWorkingId(null); }
  }

  async function loadArchive(offset = 0) {
    try {
      const page = await api<{ items: ContentArchiveEntry[]; next_offset: number | null }>(`/content/archive?limit=30&offset=${offset}`);
      setArchiveItems((current) => offset ? [...current, ...page.items] : page.items);
      setArchiveNext(page.next_offset);
    } catch (reason) { setError((reason as Error).message); }
  }
  async function reuseArchive(id: string) {
    if (!archiveTargets.length) return;
    try {
      const copy = await api<ContentItem>(`/content/archive/${id}/reuse`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrf_token }, body: JSON.stringify({ platforms: archiveTargets }) });
      setArchiveOpen(false); setArchiveSelected(null);
      const targetWeek = mondayFor(new Date(copy.scheduled_at));
      if (dateInputValue(targetWeek) === dateInputValue(weekStart)) await load(); else setWeekStart(targetWeek);
    } catch (reason) { setError((reason as Error).message); }
  }
  const activeItems = items.filter((item) => item.publications.length ? item.publications.some((publication) => publication.status !== 'published') : item.status !== 'published');
  const grouped = activeItems.reduce<Record<string, ContentItem[]>>((result, item) => {
    const key = dateInputValue(new Date(item.scheduled_at));
    (result[key] ||= []).push(item);
    return result;
  }, {});
  const formatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
  const firstContentSlot = nextContentSlot();
  const defaultSchedule = new Date(weekStart);
  defaultSchedule.setHours(10, 0, 0, 0);
  if (defaultSchedule < firstContentSlot) defaultSchedule.setTime(firstContentSlot.getTime());

  return <section className="content-planner">
    <div className="section-heading content-heading"><div><p className="eyebrow">Контент студии</p><h1>Темы на неделю</h1><p>Вы согласуете только темы. После утверждения плана агент заранее подберёт материалы, прочитает комментарии, подготовит тексты для трёх площадок и будет публиковать их по расписанию.</p></div><span>{items.length}</span></div>
    <div className="content-form-actions">
      <button type="button" onClick={() => { setArchiveOpen(false); setCreateMode('day'); setNewContentFormat('availability'); setCreating(true); }}>Свободные окошки</button>
      <button type="button" onClick={() => { setArchiveOpen(false); setCreateMode('day'); setNewContentFormat('post'); setCreating(true); }}>Создать публикацию</button>
      <button type="button" onClick={() => { setArchiveOpen(false); setPlanDay(true); setPlanDate(dateInputValue(new Date())); setCreateMode('week'); setCreating(true); }}>План на день</button>
      <button type="button" onClick={() => { setArchiveOpen(false); setPlanDay(false); setCreateMode('week'); setCreating(true); }}>План на неделю</button>
      <button type="button" onClick={() => { setCreating(false); setArchiveOpen((open) => !open); if (!archiveOpen) void loadArchive(); }}>Архив публикаций</button>
      {session.user.can_access_analytics && <button type="button" onClick={() => setAnalyticsOpen((open) => !open)}>Аналитика</button>}
    </div>
    {analyticsOpen && <ContentAnalytics session={session} />}
    {archiveOpen && <section><h2>Архив публикаций</h2>{!archiveItems.length && <p>Опубликованных материалов пока нет.</p>}{archiveItems.map((entry) => <article className="content-card" key={entry.publication_id}><div className="analytics-switch">{(['telegram', 'instagram', 'max', 'vk', 'threads'] as ContentPlatform[]).map(platform => <span key={platform} style={{padding:'6px 10px', borderRadius:12, background:(entry.platforms ?? [entry.platform]).includes(platform)?'#d6efd9':'#eee', color:(entry.platforms ?? [entry.platform]).includes(platform)?'#205c31':'#777'}}>{(entry.platforms ?? [entry.platform]).includes(platform)?'●':'○'} {CONTENT_PLATFORM_LABELS[platform]}</span>)}</div><small>Последнее размещение: {new Date(entry.published_at).toLocaleString('ru-RU')}. Повтор использует его версию.</small><h3>{entry.title}</h3><p>{entry.description}</p>{entry.preview_media_id && <img style={{ maxWidth: 220 }} src={`/api/v1/content/archive/${entry.publication_id}/media/${entry.preview_media_id}`} alt="Материал публикации" />}<button type="button" onClick={() => { setArchiveSelected(entry.publication_id); setArchiveTargets([entry.platform]); }}>Разместить повторно</button>{archiveSelected === entry.publication_id && <><div>{(['telegram', 'max', 'instagram', 'vk', 'threads'] as ContentPlatform[]).map((platform) => <label key={platform}><input type="checkbox" checked={archiveTargets.includes(platform)} onChange={() => setArchiveTargets((current) => current.includes(platform) ? current.filter((value) => value !== platform) : [...current, platform])} />{CONTENT_PLATFORM_LABELS[platform]}</label>)}</div><button type="button" disabled={!archiveTargets.length} onClick={() => void reuseArchive(entry.publication_id)}>Создать публикацию</button></>}</article>)}{archiveNext !== null && <button type="button" onClick={() => void loadArchive(archiveNext)}>Показать ещё</button>}</section>}
    <div className="content-week-bar"><button type="button" onClick={() => changeWeek(-7)}>←</button><strong>{formatter.format(weekStart)} — {formatter.format(weekEnd)}</strong><button type="button" onClick={() => changeWeek(7)}>→</button></div>
    <div className="content-summary"><div><b>{activeItems.length}</b><span>ожидают публикации</span></div><div><b>{activeItems.filter((item) => ["approved", "generating", "ready", "scheduled"].includes(item.status)).length}</b><span>тем утверждено</span></div><div><b>{activeItems.filter((item) => ["ready", "scheduled"].includes(item.status)).length}</b><span>материалов готово</span></div></div>
    {creating && <div className="content-create-box">
    {createMode === "day" ? <form className="content-create-form" onSubmit={createItem}>
      <fieldset className="content-format-choice"><legend>Что готовим</legend><label><input type="radio" name="content_format" value="post" checked={newContentFormat === "post"} onChange={() => setNewContentFormat("post")} />Пост</label><label><input type="radio" name="content_format" value="story" checked={newContentFormat === "story"} onChange={() => setNewContentFormat("story")} />История</label><label><input type="radio" name="content_format" value="availability" checked={newContentFormat === "availability"} onChange={() => setNewContentFormat("availability")} />Свободные окна</label></fieldset>
      {newContentFormat !== "availability" && <fieldset className="content-visual-style-choice"><legend>Стиль макета</legend><label><input type="radio" name="visual_style" value="auto" checked={newVisualStyle === "auto"} onChange={() => setNewVisualStyle("auto")} />Авто</label><label><input type="radio" name="visual_style" value="light" checked={newVisualStyle === "light"} onChange={() => setNewVisualStyle("light")} />Светлый / белый</label><label><input type="radio" name="visual_style" value="dark" checked={newVisualStyle === "dark"} onChange={() => setNewVisualStyle("dark")} />Тёмный / чёрный</label><small className="muted">Выбранный стиль фиксируется: светлый всегда получает светлую основу, тёмный — чёрно‑золотую.</small></fieldset>}
      {newContentFormat !== "availability" && <label>{sourceImageEdit ? "Результат обработки" : "Тема"}<div className="voice-input-row"><input name="title" minLength={2} maxLength={180} required value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder={sourceImageEdit ? "Например, ретушь результата перманента губ" : "Например, результат процедуры до/после"} /><VoiceInputButton csrfToken={session.csrf_token} onAppend={(spoken) => setNewTitle((current) => appendDictatedText(current, spoken))} /></div><small className="muted">Можно надиктовать тему: нажмите «Стоп», и текст появится в поле.</small></label>}
      {newContentFormat === "availability" && <label>Мастер для окон<select name="availability_staff_id" required defaultValue=""><option value="" disabled>Выберите мастера</option>{availabilityStaff.map((entry) => <option key={entry.staff_id} value={entry.staff_id}>{entry.staff_name}{entry.specialization ? ` — ${entry.specialization}` : ""}</option>)}</select><small className="muted">Будет использован только шаблон, в комментарии к которому указан этот мастер.</small></label>}
      {newContentFormat !== "availability" && <><label>{sourceImageEdit ? "Что изменить на фото" : "Уточнение для агента"} <small className="muted">необязательно</small><textarea name="editor_instruction" maxLength={1000} value={newEditorInstruction} onChange={(event) => setNewEditorInstruction(event.target.value)} placeholder={sourceImageEdit ? "Например: «Убери маску, добавь чёрные перчатки, сделай мягкую ретушь. Добавь золотую надпись и логотип VIOLETTA»." : "Например: «сгенерируй видео о процедуре», «сгенерируй картинку в тёмной золотой стилистике»."} /><div className="voice-input-row"><VoiceInputButton csrfToken={session.csrf_token} onAppend={(spoken) => setNewEditorInstruction((current) => appendDictatedText(current, spoken))} /></div><small className="muted">Новое уточнение дополняет тему и сохраняется вместе с ней.</small></label><div className="content-source-picker"><div><strong>Фото и видео из хранилища</strong><small>{selectedSourceMedia.length ? "Выбрано: " + selectedSourceMedia.length : "Необязательно: агент подберёт разрешённые материалы сам."}</small></div><button type="button" className="quiet" onClick={() => void openContentLibrary()}>Выбрать материалы</button></div>{selectedSourceMedia.length > 0 && <section className="source-image-edit"><label><input type="checkbox" checked={sourceImageEdit} onChange={(event) => setSourceImageEdit(event.target.checked)} /> <span><strong>Обработать выбранное фото с ИИ</strong><small>Создаст новую версию: можно ретушировать, добавить или убрать детали, добавить надписи и логотип. Оригинал останется без изменений.</small></span></label></section>}{contentLibraryOpen && renderContentLibrary(selectedSourceMedia, setSelectedSourceMedia, 10)}</>}
      <label>Фото в посте<select name="media_limit" defaultValue="1"><option value="1">1 фото</option><option value="2">2 фото</option><option value="3">3 фото</option><option value="4">4 фото</option><option value="5">5 фото</option><option value="6">6 фото</option><option value="7">7 фото</option><option value="8">8 фото</option><option value="9">9 фото</option><option value="10">10 фото</option></select><small className="muted">Для истории агент возьмёт один вертикальный материал; для «Свободных окон» — макет из папки «Шаблоны».</small></label>
      <fieldset><legend>Когда размещать</legend><label><input type="checkbox" checked={newDateAssigned} onChange={(event) => setNewDateAssigned(event.target.checked)} />Запланировать на дату и время</label></fieldset>
      {newDateAssigned ? <label>Дата и время<input name="scheduled_at" type="datetime-local" required min={dateTimeLocalValue(firstContentSlot)} defaultValue={dateTimeLocalValue(defaultSchedule)} /><small className="muted">Только будущее время. На подготовку материала автоматически заложено не менее 30 минут.</small></label> : <input type="hidden" name="scheduled_at" value={dateTimeLocalValue(defaultSchedule)} />}
      <fieldset><legend>Площадки</legend><label><input type="checkbox" name="telegram" checked={newTelegramSelected} onChange={(event) => setNewTelegramSelected(event.target.checked)} />Telegram</label><label><input type="checkbox" name="max" checked={newMaxSelected} onChange={(event) => setNewMaxSelected(event.target.checked)} />MAX</label><label><input type="checkbox" name="instagram" checked={newInstagramSelected} onChange={(event) => setNewInstagramSelected(event.target.checked)} />Instagram</label><label><input type="checkbox" name="vk" />ВКонтакте · стена</label><label><input type="checkbox" name="threads" />Threads</label></fieldset>
      {newContentFormat === 'story' && <p className="muted">«История» — формат макета. Для публикации в истории выберите соответствующий формат площадки.</p>}
      {newMaxSelected && <label>Формат MAX<select value={newMaxFormat} onChange={(event) => setNewMaxFormat(event.target.value as PublicationFormat)}><option value="post">Пост сообщества</option><option value="story">История аккаунта студии</option></select><small className="muted">Истории размещаются от подключённого аккаунта MAX, каждый файл — отдельная история.</small></label>}
      {newTelegramSelected && <label>Формат Telegram<select aria-label="Формат Telegram" value={newTelegramFormat} onChange={(event) => setNewTelegramFormat(event.target.value as PublicationFormat)}><option value="post">Пост</option><option value="story">История канала</option></select><small className="muted">Для историй подключите аккаунт администратора канала. Фото и видео размещаются отдельными историями по порядку.</small></label>}
      {newInstagramSelected && <label>Формат Instagram<select aria-label="Формат Instagram" value={newInstagramFormat} onChange={(event) => setNewInstagramFormat(event.target.value as PublicationFormat)}><option value="post">Пост</option><option value="story">Сторис</option><option value="reel">Reels</option></select><small className="muted">{newInstagramFormat === "reel" ? "Выберите одно готовое видео. Генерация видео пока не поддерживается." : newInstagramFormat === "story" ? "До 10 фото или видео — каждое выйдет отдельной сторис по порядку." : "Фото или карусель."}</small></label>}
      <div className="content-form-actions"><button type="submit" disabled={workingId !== null}>{workingId ? "Генерирую…" : newContentFormat === "availability" ? "Сгенерировать окна" : sourceImageEdit ? "Обработать фото ИИ" : "Сгенерировать контент"}</button><button type="button" className="quiet" onClick={() => setCreating(false)}>Отмена</button></div>
    </form> : <form className="content-create-form" onSubmit={createWeek}>
      {planDay && <label>Дата плана<input type="date" required value={planDate} onChange={(event) => setPlanDate(event.target.value)} /></label>}
      <div className="weekly-content-entries">
        <strong>План публикаций</strong>
        <p className="muted">Каждая строка — отдельная публикация. Выберите площадки, формат и визуальный стиль именно для неё.</p>
        {weekEntries.map((entry, index) => <div className="weekly-content-entry" key={index}>
          <div className="weekly-entry-main">
            {!planDay && <select aria-label="День недели" value={entry.day} onChange={(event) => setWeekEntries((items) => items.map((item, position) => position === index ? { ...item, day: Number(event.target.value) } : item))}>{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((label, day) => <option key={label} value={day}>{label}</option>)}</select>}
            <div className="weekly-topic-field"><input value={entry.title} onChange={(event) => setWeekEntries((items) => items.map((item, position) => position === index ? { ...item, title: event.target.value } : item))} placeholder="Тема или посыл" required /><VoiceInputButton csrfToken={session.csrf_token} compact onAppend={(spoken) => setWeekEntries((items) => items.map((item, position) => position === index ? { ...item, title: appendDictatedText(item.title, spoken) } : item))} /></div>
            <select aria-label="Основной макет" value={entry.content_format} onChange={(event) => setWeekEntries((items) => items.map((item, position) => position === index ? { ...item, content_format: event.target.value as ContentFormat } : item))}><option value="post">Макет поста</option><option value="story">Вертикальный макет</option><option value="availability">Окна</option></select>
            <select aria-label="Стиль макета" value={entry.visual_style} onChange={(event) => setWeekEntries((items) => items.map((item, position) => position === index ? { ...item, visual_style: event.target.value as ContentVisualStyle } : item))}><option value="auto">Авто</option><option value="light">Светлый / белый</option><option value="dark">Тёмный / чёрный</option></select>
            <select aria-label="Количество фото" value={entry.media_limit} onChange={(event) => setWeekEntries((items) => items.map((item, position) => position === index ? { ...item, media_limit: Number(event.target.value) } : item))}>{[1,2,3,4,5,6,7,8,9,10].map((count) => <option key={count} value={count}>{count} фото</option>)}</select>
            {weekEntries.length > 1 && <button type="button" className="quiet" aria-label="Удалить строку" onClick={() => setWeekEntries((items) => items.filter((_, position) => position !== index))}>×</button>}
          </div>
          <div className="weekly-platform-formats">{(["telegram", "instagram", "max", "vk", "threads"] as ContentPlatform[]).map((platform) => { const selected = entry.platforms.includes(platform); const formats = entry.platform_formats[platform] || ["post"]; const title = platform === "telegram" ? "Telegram" : platform === "instagram" ? "Instagram" : platform === "vk" ? "ВКонтакте · стена" : platform === "threads" ? "Threads" : "MAX"; const options: PublicationFormat[] = platform === "instagram" ? ["post", "story", "reel"] : platform === "vk" || platform === "threads" ? ["post"] : ["post", "story"]; return <div key={platform} className={`weekly-platform ${selected ? "selected" : ""}`}><label className="weekly-platform-name"><input type="checkbox" checked={selected} onChange={() => setWeekEntries((items) => items.map((item, position) => { if (position !== index) return item; const platforms = selected ? item.platforms.filter((value) => value !== platform) : [...item.platforms, platform]; const platform_formats = { ...item.platform_formats }; if (!selected && !platform_formats[platform]?.length) platform_formats[platform] = ["post"]; return { ...item, platforms, platform_formats }; }))} />{title}</label>{selected && <div className="weekly-format-list">{options.map((choice) => <label key={choice}><input type="checkbox" checked={formats.includes(choice)} onChange={() => setWeekEntries((items) => items.map((item, position) => { if (position !== index) return item; const current = item.platform_formats[platform] || ["post"]; const next = current.includes(choice) ? current.filter((value) => value !== choice) : [...current, choice]; return { ...item, platforms: next.length ? item.platforms : item.platforms.filter((value) => value !== platform), platform_formats: { ...item.platform_formats, [platform]: next } }; }))} />{choice === "post" ? "Пост" : choice === "reel" ? "Reels" : platform === "telegram" ? "История канала" : platform === "max" ? "История аккаунта" : "Сторис"}</label>)}</div>}</div>; })}</div>
          {entry.platforms.includes("instagram") && entry.platform_formats.instagram?.includes("reel") && <p className="weekly-format-hint">Для Reels перед запуском плана выберите в публикации одно готовое видео.</p>}
        </div>)}
        <button type="button" className="quiet weekly-add" onClick={() => setWeekEntries((items) => [...items, { day: 0, title: "", content_format: "post", media_limit: 1, visual_style: "auto", platforms: [], platform_formats: {} }])}>＋ Ещё публикация</button>
      </div>
      <div className="content-form-actions"><button type="submit" disabled={startingPlan} onClick={() => { startPlanOnSubmit.current = false; }}>Добавить весь план</button><button type="submit" disabled={startingPlan} onClick={() => { startPlanOnSubmit.current = true; }}>Создать и запустить план</button><button type="button" className="quiet" onClick={() => setCreating(false)}>Отмена</button></div>
    </form>}</div>}
    {startingPlan && <p className="muted" role="status">Готовим материалы и запускаем план. Это может занять несколько минут.</p>}
    {error && <p className="error">{error}</p>}
    {loading ? <p className="muted">Загружаю план…</p> : activeItems.length === 0 ? <div className="content-empty"><strong>На эту неделю публикаций пока нет</strong><span>Создайте публикацию или план.</span></div> : <div className="content-days">
      {Object.entries(grouped).map(([day, dayItems]) => <section className="content-day" key={day}><h2>{new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T12:00:00`))}<span>{dayItems.length}</span></h2><div className="content-cards">{dayItems.map((item) => <article className="content-card" key={item.id}>
        <div className="content-card-time"><strong>{new Date(item.scheduled_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</strong><span className={`content-status ${item.status}`}>{CONTENT_STATUS_LABELS[item.status]}</span></div>
        <h3>{item.title}</h3><p className={`content-format-tag ${item.content_format}`}>{item.content_format === "post" ? `Пост · до ${item.media_limit} фото` : item.content_format === "story" ? "История · вертикальный макет" : "Свободные окна · шаблон"}</p>{item.editor_instruction && <p className="content-editor-instruction">Уточнение: {item.editor_instruction}</p>}{item.content_format !== 'availability' && ['draft', 'review', 'approved', 'failed', 'ready'].includes(item.status) && !item.publications.some((publication) => ['published', 'publishing'].includes(publication.status)) && <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => openRefinementDialog(item, 'regenerate')}>Редактировать уточнение и сгенерировать заново</button>}{item.caption && <p>{item.caption}</p>}
        <div className="content-platforms">{item.publications.map((publication) => <span key={publication.id} className={`${publication.platform} ${publication.status}`}>{CONTENT_PLATFORM_LABELS[publication.platform]} · {publication.publication_format === "story" ? "история" : publication.publication_format === "reel" ? "Reels" : "пост"}{item.publications.length > 1 && ["pending", "failed"].includes(publication.status) && <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => void removePlatform(item, publication)} aria-label={`Убрать ${CONTENT_PLATFORM_LABELS[publication.platform]}`}>×</button>}</span>)}</div>
        <div className="format-media-choices">{item.publications.map((publication) => <section key={publication.id} className="format-media-choice"><strong>{CONTENT_PLATFORM_LABELS[publication.platform]} · {publication.publication_format === "story" ? "сторис" : publication.publication_format === "reel" ? "Reels" : "пост"}</strong><span>{publication.media_ids.length ? `Выбрано файлов: ${publication.media_ids.length}` : "Файлы не выбраны"}</span>{!["published", "publishing", "scheduled"].includes(publication.status) && item.status !== "scheduled" && <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => void openFormatMediaPicker(item, publication)}>Выбрать файлы для формата</button>}{formatMediaTarget?.itemId === item.id && formatMediaTarget.publication.id === publication.id && <div className="content-card-media-editor"><small>{publication.publication_format === "reel" ? "Выберите одно видео." : "Выберите фото или видео для этого формата."}</small>{renderContentLibrary(replacementMedia, setReplacementMedia, publication.publication_format === "reel" ? 1 : 10)}<div className="content-form-actions"><button type="button" disabled={workingId === item.id} onClick={() => void saveFormatMedia(item, publication)}>Сохранить файлы</button><button type="button" className="quiet" onClick={() => setFormatMediaTarget(null)}>Отмена</button></div></div>}</section>)}</div>
        {item.publications.some((publication) => publication.caption) && <div className="content-generated-texts">{item.publications.filter((publication) => publication.caption).map((publication) => { const isStory = item.content_format === "story" || publication.publication_format === "story"; return <section key={publication.id} className={`content-post-preview ${isStory || item.content_format === "availability" ? "story-preview" : ""}`}><div className="content-post-preview-head"><span>{CONTENT_PLATFORM_LABELS[publication.platform]} · предпросмотр</span><small>{isStory ? "история" : item.content_format === "availability" ? "свободные окна на макете" : publication.media_ids.length ? `${publication.media_ids.length} файл(а)` : "текстовый пост"}</small></div>{publication.media_ids.length > 0 && <div className={`content-post-preview-media count-${item.content_format === "availability" ? 1 : Math.min(publication.media_ids.length, 4)}`}>{publication.media_ids.slice(0, item.content_format === "availability" ? 1 : 4).map((mediaId, index) => <div className="content-post-preview-file" key={mediaId}><img src={`/api/v1/media/${mediaId}/thumbnail`} alt={`Материал ${index + 1}`} />{isStory && <b className="story-overlay">{item.title}</b>}{index === 3 && publication.media_ids.length > 4 && <b>+{publication.media_ids.length - 4}</b>}</div>)}</div>}<p>{publication.caption}</p>{publication.error && <small className="error">{publication.error}</small>}{publication.status === "failed" && !publication.external_id && /проверьте|неизвестен/i.test(publication.error || "") && <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => void confirmNotPublished(item, publication)}>Я проверил: публикации нет</button>}</section>; })}</div>}
        {replacingMediaFor === item.id && <section className="content-card-media-editor">
          <div><strong>Сменить материалы</strong><small>Выберите до {item.media_limit} фото или видео. После сохранения агент заново подготовит текст и предпросмотр.</small></div>
          {renderContentLibrary(replacementMedia, setReplacementMedia, item.media_limit)}
          <div className="content-form-actions"><button type="button" disabled={workingId === item.id} onClick={() => void saveManualMediaPicker(item)}>{workingId === item.id ? "Сохраняю…" : "Сохранить материалы"}</button><button type="button" className="quiet" disabled={workingId === item.id} onClick={() => { setReplacingMediaFor(null); setReplacementMedia([]); }}>Отмена</button></div>
        </section>}
        <div className="content-card-actions">
          {["draft", "review", "approved", "failed"].includes(item.status) && item.publications.some((publication) => publication.platform === "instagram" && publication.publication_format === "reel") && <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => void openManualMediaPicker(item)}>Выбрать видео для Reels</button>}
          {["draft", "review", "approved"].includes(item.status) && <button type="button" disabled={workingId === item.id} onClick={() => void prepare(item)}>{workingId === item.id ? "Генерирую…" : item.content_format === "availability" ? "Сгенерировать окна" : "Сгенерировать контент"}</button>}
          {item.status === "failed" && item.publications.some((publication) => publication.platform === "telegram") && <button type="button" disabled={workingId === item.id} onClick={() => void prepare(item)}>{workingId === item.id ? "Генерирую…" : item.content_format === "availability" ? "Повторить сборку окон" : "Повторить генерацию"}</button>}
          {item.status === "ready" && item.publications.some((publication) => publication.caption) && <>
            {item.content_format === "availability" && <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => void changeAvailabilityMaster(item)}>Сменить мастера</button>}
            {item.publication_date_assigned && <button type="button" disabled={workingId === item.id} onClick={() => void setStatus(item, "scheduled")}>{workingId === item.id ? "Планирую…" : "Запланировать выбранные площадки"}</button>}
            <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => void changeCaption(item, item.publications.find((publication) => publication.caption)!)}>Сменить подпись</button>
            {item.content_format !== "availability" && <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => openRefinementDialog(item, "visual")}>Уточнить картинку</button>}
            <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => openRefinementDialog(item, "selection")}>Уточнить подбор</button>
            <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => void openManualMediaPicker(item)}>Сменить фото</button>
          </>}
          {item.status === "scheduled" && item.publications.some((publication) => publication.caption) && <>
            <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => void rollbackToDraft(item)}>{workingId === item.id ? "Откатываю…" : "↶ В черновик"}</button>
            <button type="button" className="quiet" disabled={workingId === item.id} onClick={() => void openManualMediaPicker(item)}>Сменить фото/видео</button>
            {item.publications.some((publication) => publication.platform === "telegram" && publication.caption && publication.status !== "published") && <button type="button" disabled={workingId === item.id} onClick={() => void publishTelegram(item)}>{workingId === item.id ? "Публикую…" : "Опубликовать в Telegram"}</button>}
            {item.publications.some((publication) => publication.platform === "instagram" && publication.caption && publication.status !== "published") && <button type="button" disabled={workingId === item.id} onClick={() => void publishInstagram(item)}>{workingId === item.id ? "Публикую…" : "Опубликовать в Instagram"}</button>}
          </>}
          {!item.publication_date_assigned && ["ready", "failed"].includes(item.status) && item.publications.some((publication) => publication.status !== "published") && <button type="button" disabled={workingId === item.id} onClick={() => void publishSelected(item)}>{workingId === item.id ? "Размещаю…" : item.publications.length > 1 ? "Разместить на выбранных площадках" : `Разместить в ${CONTENT_PLATFORM_LABELS[item.publications[0].platform]} · ${item.publications[0].publication_format === "story" ? "Сторис" : item.publications[0].publication_format === "reel" ? "Reels" : "Пост"}`}</button>}
          {["draft", "review", "approved", "ready", "failed"].includes(item.status) && <button type="button" className="quiet" onClick={() => void remove(item)}>Удалить</button>}
        </div>
      </article>)}</div></section>)}
    </div>}
    {refinementDialog && <div className="content-refinement-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && workingId !== refinementDialog.item.id) setRefinementDialog(null); }}>
      <form className="content-refinement-dialog" role="dialog" aria-modal="true" aria-labelledby="content-refinement-title" onSubmit={submitRefinement}>
        <div>
          <p className="eyebrow">Сохранить контекст</p>
          <h2 id="content-refinement-title">{refinementDialog.kind === "regenerate" ? "Сгенерировать заново" : refinementDialog.kind === "visual" ? "Уточнить картинку" : "Уточнить подбор материалов"}</h2>
          <p className="muted">{refinementDialog.kind === 'regenerate' ? 'Измените уточнение или оставьте его без изменений. Материал будет подготовлен заново с учётом формата и выбранных файлов.' : 'Новое уточнение добавится к исходной теме и прежним правкам — они не будут заменены.'}</p>
        </div>
        <label>Уточнение для генерации<textarea autoFocus value={refinementDialog.text} maxLength={1000} onChange={(event) => setRefinementDialog((current) => current ? { ...current, text: event.target.value } : current)} placeholder={refinementDialog.kind === "visual" ? "Например: «Цену 4 000 ₽ сделать крупнее и по центру нижнего золотого блока»." : "Например: «Только глаза со стрелками, без губ и пирсинга»."} /></label>
        <div className="voice-input-row voice-input-row-solo"><VoiceInputButton csrfToken={session.csrf_token} onAppend={(spoken) => setRefinementDialog((current) => current ? { ...current, text: appendDictatedText(current.text, spoken) } : current)} disabled={workingId === refinementDialog.item.id} /></div>
        {refinementError && <p className="error">{refinementError}</p>}
        <div className="content-form-actions"><button type="submit" disabled={workingId === refinementDialog.item.id}>{workingId === refinementDialog.item.id ? "Генерирую…" : refinementDialog.kind === "selection" ? "Уточнить подбор" : "Сгенерировать заново"}</button><button type="button" className="quiet" disabled={workingId === refinementDialog.item.id} onClick={() => setRefinementDialog(null)}>Отмена</button></div>
      </form>
    </div>}
  </section>;
}

function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  type Screen = "main" | "chats" | "admin" | "content";
  type MediaMode = "add" | "browse";
  const mediaModeStorageKey = `vita29-media-mode:${session.user.id}`;
  const mediaModeFromLocation = (): MediaMode => {
    if (!session.user.can_upload_media) return "browse";
    if (window.location.hash === "#add") return "add";
    if (window.location.hash === "#browse") return "browse";
    return localStorage.getItem(mediaModeStorageKey) === "browse" ? "browse" : "add";
  };
  const screenFromHash = (): Screen => {
    if (window.location.hash === "#chats" && session.user.can_access_chats) return "chats";
    if (window.location.hash === "#admin" && session.user.can_access_admin) return "admin";
    if (window.location.hash === "#content" && session.user.can_access_content) return "content";
    return "main";
  };
  const [screen, setScreen] = useState<Screen>(screenFromHash);
  const [mediaMode, setMediaMode] = useState<MediaMode>(mediaModeFromLocation);
  const [chatMediaId, setChatMediaId] = useState<string | null>(null);
  const [contentMediaIds, setContentMediaIds] = useState<string[]>([]);

  useEffect(() => {
    const handleNavigation = () => {
      const nextScreen = screenFromHash();
      setScreen(nextScreen);
      if (nextScreen === "main") setMediaMode(mediaModeFromLocation());
    };
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
  }, []);

  function openChats(media?: Media) {
    setChatMediaId(media?.id ?? null);
    if (window.location.hash !== "#chats") window.history.pushState({ screen: "chats" }, "", "#chats");
    setScreen("chats");
  }

  function openAdmin() {
    if (window.location.hash !== "#admin") window.history.pushState({ screen: "admin" }, "", "#admin");
    setScreen("admin");
  }

  function openContent(files: Media[] = []) {
    setContentMediaIds(files.map((file) => file.id));
    if (window.location.hash !== "#content") window.history.pushState({ screen: "content" }, "", "#content");
    setScreen("content");
  }

  function switchMediaMode(mode: MediaMode) {
    const hash = mode === "add" ? "#add" : "#browse";
    localStorage.setItem(mediaModeStorageKey, mode);
    if (window.location.hash !== hash) window.history.replaceState({ screen: "main", mediaMode: mode }, "", hash);
    setMediaMode(mode);
    setScreen("main");
  }

  function closePage() {
    setChatMediaId(null);
    if (["#chats", "#admin", "#content"].includes(window.location.hash)) window.history.back();
    else setScreen("main");
  }

  async function logout() {
    await api<void>("/auth/logout", { method: "POST", headers: { "X-CSRF-Token": session.csrf_token } });
    onLogout();
  }

  return (
    <main className="app-shell">
      <header><div className="brand"><img className="mini-mark" src="/logo.svg" alt="" /><div><strong>VIOLETTA</strong><small>{screen === "chats" ? "чаты студии" : screen === "admin" ? "администрирование" : screen === "content" ? "контент студии" : mediaMode === "add" ? "добавление материалов" : "просмотр архива"}</small></div></div><div className="header-actions">{screen !== "main" ? <button className="header-back" onClick={closePage}>← Назад</button> : <>{session.user.can_access_content && <button className="header-content" onClick={() => openContent()}><span aria-hidden="true">✦</span><b>Контент</b></button>}{session.user.can_access_admin && <button className="header-admin" onClick={openAdmin}><span aria-hidden="true">⚙</span><b>Админка</b></button>}{session.user.can_access_chats && <HeaderChatButton onOpen={() => openChats()} />}</>}<button className="quiet" onClick={logout}>Выйти</button></div></header>
      {screen === "chats" ? <div className="content chat-page"><DiscussionsPanel session={session} initialMediaId={chatMediaId} onInitialMediaHandled={() => setChatMediaId(null)} /></div> : screen === "admin" ? <div className="content admin-page"><AdminPanel session={session} /></div> : screen === "content" ? <div className="content content-page"><ContentPanel session={session} initialMediaIds={contentMediaIds} onInitialMediaHandled={() => setContentMediaIds([])} /></div> : <div className="content">
        <section className="welcome"><p className="eyebrow">Добро пожаловать</p><h1>{session.user.display_name}</h1><p>Рабочие папки открыты для команды, а приватные — только для приглашённых участников.</p></section>
        <StoragePanel />
        <AccountPanel session={session} />
        <section className={`media-page-links ${session.user.can_upload_media ? "" : "single"}`} aria-label="Работа с фото и видео">
          {session.user.can_upload_media && <button className={`media-page-link add ${mediaMode === "add" ? "active" : ""}`} type="button" aria-pressed={mediaMode === "add"} onClick={() => switchMediaMode("add")}><span className="media-link-icon" aria-hidden="true">＋</span><span><small>Новые материалы</small><strong>Добавить фото и видео</strong><em>Выбрать папку, дату и визит YCLIENTS</em></span><b aria-hidden="true">↓</b></button>}
          <button className={`media-page-link browse ${mediaMode === "browse" ? "active" : ""}`} type="button" aria-pressed={mediaMode === "browse"} onClick={() => switchMediaMode("browse")}><span className="media-link-icon" aria-hidden="true">▦</span><span><small>Архив студии</small><strong>Просмотр материалов</strong><em>Папки, календарь, клиенты, даты и геометки</em></span><b aria-hidden="true">↓</b></button>
        </section>
        <MediaPanel session={session} mode={mediaMode} onCreateChat={(file) => openChats(file)} onCreateContent={(files) => openContent(files)} />
      </div>}
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Session>("/auth/me").then(setSession).catch(() => undefined).finally(() => setLoading(false));
  }, []);

  if (loading) return <main className="shell"><img className="loader" src="/logo.svg" alt="" /></main>;
  return session ? <Dashboard session={session} onLogout={() => setSession(null)} /> : <Login onLogin={setSession} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
