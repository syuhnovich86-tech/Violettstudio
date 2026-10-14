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
};

type Session = { user: User; csrf_token: string };
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
  mode,
}: {
  session: Session;
  onCreateChat: (file: Media) => void;
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
    ? privateFilterOptions.months.filter((item) => item.year === Number(captureYear))
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
    const preparation = new Promise<File>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("GET", `/api/v1/media/${file.id}/download`);
      request.responseType = "blob";
      request.onprogress = (event) => {
        const percent = event.lengthComputable && event.total > 0
          ? Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)))
          : 5;
        setShareProgress((current) => ({ ...current, [file.id]: percent }));
      };
      request.onload = () => {
        if (request.status < 200 || request.status >= 300) {
          reject(new Error("Не удалось подготовить видео"));
          return;
        }
        const extension = file.mime_type === "video/quicktime" ? "mov" : "mp4";
        const readyFile = new File([request.response], `Violetta-video-${file.id.slice(0, 8)}.${extension}`, { type: file.mime_type });
        preparedShareFiles.current.set(file.id, readyFile);
        setShareProgress((current) => ({ ...current, [file.id]: 100 }));
        resolve(readyFile);
      };
      request.onerror = () => reject(new Error("Не удалось подготовить видео"));
      request.send();
    }).catch((reason) => {
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
    void api<CalendarUser[]>("/yclients/calendar-users")
      .then((users) => {
        setCalendarUsers(users);
        const own = users.find((item) => item.user_id === session.user.id);
        setCalendarUser(own?.user_id ?? users[0]?.user_id ?? "");
      })
      .catch(() => setMessage("Не удалось загрузить сотрудников YCLIENTS"));
  }, [session.user.id]);

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
    if (commentParticipants.length === 0) {
      void api<DiscussionParticipant[]>("/discussions/participants")
        .then(setCommentParticipants)
        .catch(() => undefined);
    }
  }

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
      {mode === "browse" && <details className="media-action-legend"><summary>Обозначения кнопок</summary><div><span><b>↗</b> Поделиться</span><span><b>💬</b> Комментарий</span><span><b>◌</b> Создать чат</span><span><b>⇄</b> В другую папку</span><span><b>↓</b> Скачать</span><span><b>⛔</b> Запретить публикацию</span><span><b>×</b> Удалить</span></div></details>}
      {mode === "browse" && (files.length === 0 ? <div className="empty"><strong>Здесь пока пусто</strong><span>В этой папке пока нет фото или видео.</span></div> : (
        <><div className="media-grid">{files.map((file) => (
          <article className="media-card" key={file.id}>
            {!file.publication_allowed && <span className="no-publish-badge" title="Публикация запрещена" aria-label="Публикация запрещена">⛔</span>}
            {effectiveComment(file) && <span className="comment-badge" title={effectiveComment(file) || ""}>💬</span>}
            <button className={`media-visual ${file.media_type}`} onClick={() => setPreview(file)} aria-label={`Открыть ${file.original_name}`}>
              <img src={`/api/v1/media/${file.id}/thumbnail`} alt="" loading="lazy" />
              {file.media_type === "video" && <span className="video-play" aria-hidden="true">▶</span>}
            </button>
            {file.media_type === "video" && <div className={`video-share-progress ${shareProgress[file.id] === 100 ? "ready" : ""}`}><span style={{ width: `${shareProgress[file.id] ?? 0}%` }} /><b>{shareProgress[file.id] === 100 ? "Готово к отправке · 100%" : `Подготовка видео · ${shareProgress[file.id] ?? 0}%`}</b></div>}
            <div className="card-actions">
              <button className={`share-card ${file.publication_allowed ? "" : "blocked"} ${videoIsPreparing(file) ? "preparing" : ""}`} disabled={!file.publication_allowed || videoIsPreparing(file)} onClick={() => share(file)}><span aria-hidden="true">↗</span> {!file.publication_allowed ? "Запрещено" : videoIsPreparing(file) ? `Готовим ${shareProgress[file.id]}%` : "Поделиться"}</button>
              <details className="card-more">
                <summary title="Другие действия" aria-label="Другие действия">•••</summary>
                <div className="card-more-actions">
                  <button className="move-action" onClick={() => openMove(file)} title="Переместить в папку" aria-label="Переместить в папку">⇄</button>
                  <button onClick={() => openDownload(file)} title="Скачать" aria-label="Скачать">↓</button>
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
    </section>
  );
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

function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  type Screen = "main" | "chats" | "admin";
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
    return "main";
  };
  const [screen, setScreen] = useState<Screen>(screenFromHash);
  const [mediaMode, setMediaMode] = useState<MediaMode>(mediaModeFromLocation);
  const [chatMediaId, setChatMediaId] = useState<string | null>(null);

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

  function switchMediaMode(mode: MediaMode) {
    const hash = mode === "add" ? "#add" : "#browse";
    localStorage.setItem(mediaModeStorageKey, mode);
    if (window.location.hash !== hash) window.history.replaceState({ screen: "main", mediaMode: mode }, "", hash);
    setMediaMode(mode);
    setScreen("main");
  }

  function closePage() {
    setChatMediaId(null);
    if (["#chats", "#admin"].includes(window.location.hash)) window.history.back();
    else setScreen("main");
  }

  async function logout() {
    await api<void>("/auth/logout", { method: "POST", headers: { "X-CSRF-Token": session.csrf_token } });
    onLogout();
  }

  return (
    <main className="app-shell">
      <header><div className="brand"><img className="mini-mark" src="/logo.svg" alt="" /><div><strong>VIOLETTA</strong><small>{screen === "chats" ? "чаты студии" : screen === "admin" ? "администрирование" : mediaMode === "add" ? "добавление материалов" : "просмотр архива"}</small></div></div><div className="header-actions">{screen !== "main" ? <button className="header-back" onClick={closePage}>← Назад</button> : <>{session.user.can_access_admin && <button className="header-admin" onClick={openAdmin}><span aria-hidden="true">⚙</span><b>Админка</b></button>}{session.user.can_access_chats && <HeaderChatButton onOpen={() => openChats()} />}</>}<button className="quiet" onClick={logout}>Выйти</button></div></header>
      {screen === "chats" ? <div className="content chat-page"><DiscussionsPanel session={session} initialMediaId={chatMediaId} onInitialMediaHandled={() => setChatMediaId(null)} /></div> : screen === "admin" ? <div className="content admin-page"><AdminPanel session={session} /></div> : <div className="content">
        <section className="welcome"><p className="eyebrow">Добро пожаловать</p><h1>{session.user.display_name}</h1><p>Рабочие папки открыты для команды, а приватные — только для приглашённых участников.</p></section>
        <StoragePanel />
        <AccountPanel session={session} />
        <section className={`media-page-links ${session.user.can_upload_media ? "" : "single"}`} aria-label="Работа с фото и видео">
          {session.user.can_upload_media && <button className={`media-page-link add ${mediaMode === "add" ? "active" : ""}`} type="button" aria-pressed={mediaMode === "add"} onClick={() => switchMediaMode("add")}><span className="media-link-icon" aria-hidden="true">＋</span><span><small>Новые материалы</small><strong>Добавить фото и видео</strong><em>Выбрать папку, дату и визит YCLIENTS</em></span><b aria-hidden="true">↓</b></button>}
          <button className={`media-page-link browse ${mediaMode === "browse" ? "active" : ""}`} type="button" aria-pressed={mediaMode === "browse"} onClick={() => switchMediaMode("browse")}><span className="media-link-icon" aria-hidden="true">▦</span><span><small>Архив студии</small><strong>Просмотр материалов</strong><em>Папки, календарь, клиенты, даты и геометки</em></span><b aria-hidden="true">↓</b></button>
        </section>
        <MediaPanel session={session} mode={mediaMode} onCreateChat={(file) => openChats(file)} />
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
