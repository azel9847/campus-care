import {
  Activity, AlertCircle, ArrowDownToLine, ArrowUpRight, Bell, Building2, Check,
  CheckCircle2, ClipboardCheck, ClipboardList, Clock3, HardHat, LayoutDashboard,
  LogOut, Menu, Plus, Radio, Search, Settings2, ShieldCheck, Wifi, WifiOff, Wrench, X,
} from "lucide-react";
import {
  createContext, FormEvent, useCallback, useContext, useEffect, useMemo, useState,
} from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  api, ApiError, apiBase, authApi, dashboardApi, getToken, newOperationId, openAttachment,
  requestsApi, saveToken, workOrdersApi,
} from "./api";
import { listPending, savePending, synchronizePending, type PendingRequest } from "./outbox";
import type {
  CampusCatalog, CatalogItem, DashboardData, MaintenanceRequest, NotificationItem, Role, User, WorkOrder,
} from "./types";
import type { AuditEntry, Station } from "./api";

interface AuthState {
  user: User | null;
  setUser: (user: User | null) => void;
  refreshKey: number;
  refresh: () => void;
}

const AuthContext = createContext<AuthState | null>(null);
const useAuth = () => {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Authentication context is unavailable.");
  return value;
};

const roleLabels: Record<Role, string> = {
  requester: "Requester",
  coordinator: "Coordinator",
  technician: "Technician",
  administrator: "Administrator",
};

const roleIcons: Record<Role, typeof Building2> = {
  requester: Building2,
  coordinator: ClipboardList,
  technician: HardHat,
  administrator: ShieldCheck,
};

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    if (!getToken()) return;
    authApi.me().then(setUser).catch(() => {
      saveToken(null);
      setUser(null);
    }).finally(() => setLoading(false));
  }, []);

  const auth = useMemo(() => ({ user, setUser, refreshKey, refresh }), [user, refreshKey, refresh]);
  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-slate-500">Connecting to CampusCare…</div>;

  return (
    <AuthContext.Provider value={auth}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <AuthPage />} />
        <Route path="/register" element={user ? <Navigate to="/" replace /> : <AuthPage register />} />
        <Route path="/*" element={user ? <Workspace /> : <Navigate to="/login" replace />} />
      </Routes>
    </AuthContext.Provider>
  );
}

function AuthPage({ register = false }: { register?: boolean }) {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = register
        ? await authApi.register(String(form.get("name")), String(form.get("email")), String(form.get("password")))
        : await authApi.login(String(form.get("email")), String(form.get("password")));
      saveToken(result.access_token);
      setUser(result.user);
      navigate("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen bg-white">
      <section className="hidden w-[46%] flex-col justify-between bg-navy p-12 text-white lg:flex">
        <Brand light />
        <div className="max-w-lg">
          <div className="mb-5 inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium text-teal-100">
            CAMPUS OPERATIONS · ONE CONNECTED WORKFLOW
          </div>
          <h1 className="text-4xl font-semibold leading-tight">A better campus starts with keeping it working.</h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-slate-300">
            Report facility issues, coordinate repairs, and follow every work order from one shared maintenance hub.
          </p>
        </div>
        <p className="text-xs text-slate-400">Distributed Campus Maintenance · LAN-connected operations</p>
      </section>
      <section className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <div className="mb-9 lg:hidden"><Brand /></div>
          <span className="text-xs font-bold uppercase tracking-[0.18em] text-teal">CampusCare</span>
          <h2 className="mt-2 text-3xl font-semibold text-navy">{register ? "Create your account" : "Welcome back"}</h2>
          <p className="mt-2 text-sm text-slate-500">{register ? "New accounts start with requester access." : "Sign in to your maintenance workspace."}</p>
          <form onSubmit={submit} className="mt-8 space-y-5">
            {register && <Field label="Full name" name="name" required minLength={2} placeholder="Your name" />}
            <Field label="Email address" name="email" type="email" required placeholder="you@campus.edu" />
            <Field label="Password" name="password" type="password" required minLength={10} placeholder="At least 10 characters" />
            {error && <ErrorBanner message={error} />}
            <button disabled={busy} className="button-primary w-full py-3">{busy ? "Please wait…" : register ? "Create account" : "Sign in"}</button>
          </form>
          <p className="mt-6 text-sm text-slate-500">
            {register ? "Already registered?" : "Need a requester account?"}{" "}
            <Link className="font-semibold text-teal hover:underline" to={register ? "/login" : "/register"}>
              {register ? "Sign in" : "Create one"}
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}

function Workspace() {
  const { user, setUser, refreshKey, refresh } = useAuth();
  const [connected, setConnected] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notice, setNotice] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const location = useLocation();

  const loadNotifications = useCallback(async () => {
    try {
      setNotifications(await dashboardApi.notifications());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Notifications could not be refreshed.");
    }
  }, []);

  useEffect(() => {
    if (!user || !getToken()) return;
    let active = true;
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let heartbeat: number | undefined;
    let retry = 1000;
    const token = getToken()!;
    const stationIdKey = `campuscare.station.${user.id}.${user.role}`;
    let stationId = localStorage.getItem(stationIdKey);
    if (!stationId) {
      stationId = `${user.role}-${newOperationId().slice(0, 8)}`;
      localStorage.setItem(stationIdKey, stationId);
    }
    const root = new URL(apiBase, window.location.href);
    const wsProtocol = root.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${root.host}${root.pathname.replace(/\/$/, "")}/ws?token=${encodeURIComponent(token)}`;

    const connect = () => {
      if (!active) return;
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        if (!active) return;
        setConnected(true);
        retry = 1000;
        socket?.send("connected");
        refresh();
        if (user.role === "requester") {
          synchronizePending().then((rows) => {
            if (rows.length) setNotice(`${rows.length} offline request${rows.length === 1 ? "" : "s"} synchronized.`);
            refresh();
          }).catch(() => setNotice("Offline requests are waiting for the central server."));
        }
      };
      socket.onmessage = () => {
        if (!active) return;
        refresh();
        void loadNotifications();
      };
      socket.onclose = () => {
        setConnected(false);
        if (!active) return;
        timer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    heartbeat = window.setInterval(() => {
      if (navigator.onLine) void dashboardApi.heartbeat(stationId!).catch(() => setConnected(false));
    }, 12000);
    void dashboardApi.heartbeat(stationId).catch(() => setConnected(false));
    void loadNotifications();
    const onNetwork = () => {
      if (navigator.onLine) {
        refresh();
        void loadNotifications();
      } else setConnected(false);
    };
    window.addEventListener("online", onNetwork);
    window.addEventListener("offline", onNetwork);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearInterval(heartbeat);
      window.removeEventListener("online", onNetwork);
      window.removeEventListener("offline", onNetwork);
      socket?.close();
    };
  }, [user, refresh, loadNotifications]);

  useEffect(() => {
    if (user?.role !== "requester" || !navigator.onLine) return;
    synchronizePending().then((rows) => {
      if (rows.length) {
        setNotice(`${rows.length} offline request${rows.length === 1 ? "" : "s"} synchronized.`);
        refresh();
      }
    }).catch(() => setNotice("Offline requests are waiting for the central server."));
  }, [user, refreshKey, refresh]);

  if (!user) return <Navigate to="/login" replace />;
  const role = user.role;
  const links = navigationFor(role);
  const activeLabel = [...links].reverse().find((item) => location.pathname.startsWith(item.to))?.label ?? "Overview";

  function signOut() {
    saveToken(null);
    setUser(null);
  }

  return (
    <div className="min-h-screen bg-canvas">
      <aside className={`${mobileNav ? "translate-x-0" : "-translate-x-full"} fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-navy px-4 py-5 text-white transition-transform lg:translate-x-0`}>
        <div className="px-3"><Brand light /></div>
        <div className="mt-9 px-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Workspace</div>
          <div className="mt-2 flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2.5">
            {(() => { const Icon = roleIcons[role]; return <Icon size={16} className="text-teal-200" />; })()}
            <span className="text-sm font-semibold">{roleLabels[role]} station</span>
          </div>
        </div>
        <nav className="mt-7 space-y-1">
          {links.map(({ label, to, icon: Icon }) => (
            <Link key={to} to={to} onClick={() => setMobileNav(false)} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${location.pathname === to ? "bg-white/15 font-semibold text-white" : "text-slate-300 hover:bg-white/10 hover:text-white"}`}>
              <Icon size={17} /> {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto rounded-2xl border border-white/10 bg-white/5 p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            {connected ? <Wifi size={15} className="text-emerald-300" /> : <WifiOff size={15} className="text-amber-300" />}
            {connected ? "Central server connected" : navigator.onLine ? "Reconnecting to server…" : "Network offline"}
          </div>
          <p className="mt-1 text-[11px] leading-4 text-slate-400">This station syncs with the shared campus system.</p>
        </div>
      </aside>
      {mobileNav && <button aria-label="Close navigation" onClick={() => setMobileNav(false)} className="fixed inset-0 z-20 bg-navy/40 lg:hidden" />}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/90 backdrop-blur">
          <div className="flex h-[72px] items-center justify-between px-5 sm:px-8">
            <div className="flex items-center gap-3">
              <button onClick={() => setMobileNav(true)} className="rounded-lg p-2 text-slate-600 lg:hidden" aria-label="Open navigation"><Menu size={20} /></button>
              <div><p className="text-xs text-slate-400">{roleLabels[role]} workspace</p><h1 className="text-lg font-semibold text-navy">{activeLabel}</h1></div>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => { void loadNotifications(); setNotice("Notifications refreshed."); }} className="relative rounded-xl border border-slate-200 p-2.5 text-slate-600 hover:bg-slate-50" aria-label="Refresh notifications">
                <Bell size={17} />{notifications.some((item) => !item.read_at) && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-rose-500" />}
              </button>
              <div className="hidden text-right sm:block"><div className="text-sm font-semibold text-slate-700">{user.name}</div><div className="text-xs capitalize text-slate-400">{role}</div></div>
              <button onClick={signOut} className="rounded-xl border border-slate-200 p-2.5 text-slate-500 hover:bg-slate-50" aria-label="Sign out"><LogOut size={17} /></button>
            </div>
          </div>
        </header>
        {(notice || !connected) && <div className={`flex items-center gap-2 px-5 py-2.5 text-xs sm:px-8 ${connected ? "bg-teal-50 text-teal-800" : "bg-amber-50 text-amber-800"}`}>
          {connected ? <CheckCircle2 size={14} /> : <WifiOff size={14} />}
          <span>{notice || (navigator.onLine ? "Connection to the central server is being restored. Saved records remain safe." : "Offline — saved records are safe. New requester reports can queue for synchronization.")}</span>
          {notice && <button aria-label="Dismiss message" className="ml-auto" onClick={() => setNotice("")}><X size={14} /></button>}
        </div>}
        <main className="mx-auto max-w-[1440px] px-5 py-7 sm:px-8">
          <Routes>
            <Route path="/" element={<Overview key={refreshKey} />} />
            <Route path="/requests" element={<RequestsPage key={refreshKey} />} />
            <Route path="/work-orders" element={<WorkOrdersPage key={refreshKey} />} />
            <Route path="/team" element={<TeamPage key={refreshKey} />} />
            <Route path="/reports" element={<ReportsPage key={refreshKey} />} />
            <Route path="/stations" element={<StationsPage key={refreshKey} />} />
            <Route path="/audit" element={<AuditPage key={refreshKey} />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <NotificationsPanel items={notifications} onRefresh={loadNotifications} />
        </main>
      </div>
    </div>
  );
}

function navigationFor(role: Role) {
  const base = [{ label: "Overview", to: "/", icon: LayoutDashboard }];
  if (role === "requester") return [...base, { label: "My requests", to: "/requests", icon: ClipboardList }, { label: "Profile", to: "/profile", icon: Settings2 }];
  if (role === "coordinator") return [...base, { label: "Request queue", to: "/requests", icon: ClipboardList }, { label: "Work orders", to: "/work-orders", icon: Wrench }, { label: "Reports", to: "/reports", icon: ArrowDownToLine }];
  if (role === "technician") return [...base, { label: "My work orders", to: "/work-orders", icon: Wrench }, { label: "Profile", to: "/profile", icon: Settings2 }];
  return [...base, { label: "All requests", to: "/requests", icon: ClipboardList }, { label: "Verification", to: "/work-orders", icon: ClipboardCheck }, { label: "Team & accounts", to: "/team", icon: ShieldCheck }, { label: "Stations", to: "/stations", icon: Radio }, { label: "Reports", to: "/reports", icon: ArrowDownToLine }, { label: "Audit trail", to: "/audit", icon: Activity }];
}

function Overview() {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [requests, setRequests] = useState<MaintenanceRequest[]>([]);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    dashboardApi.get().then(setDashboard).catch((reason) => setError(reason.message));
    requestsApi.list().then(setRequests).catch((reason) => setError(reason.message));
    workOrdersApi.list().then(setOrders).catch((reason) => setError(reason.message));
    if (user?.role === "requester") listPending().then(setPending).catch((reason) => setError(reason.message));
  }, [user]);
  if (!user) return null;
  const isRequester = user.role === "requester";
  const title = user.role === "requester" ? `Good to see you, ${user.name.split(" ")[0]}` : `${roleLabels[user.role]} operations`;
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><p className="text-sm text-slate-500">{new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p><h2 className="mt-1 text-2xl font-semibold text-navy">{title}</h2><p className="mt-1 text-sm text-slate-500">{dashboardSubheading(user.role)}</p></div>
        {isRequester && <Link to="/requests?new=1" className="button-primary"><Plus size={16} /> Report an issue</Link>}
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(user.role === "technician" ? [
          { label: "New assignments", value: dashboard?.by_status.Assigned ?? 0, caption: "Awaiting your start", icon: Clock3 },
          { label: "Active repairs", value: dashboard?.by_status["In Progress"] ?? 0, caption: "Currently in progress", icon: Wrench },
          { label: "For verification", value: dashboard?.by_status["For Verification"] ?? 0, caption: "Submitted for review", icon: ClipboardCheck },
          { label: "Completed", value: dashboard?.by_status.Completed ?? 0, caption: "Verified work orders", icon: CheckCircle2 },
        ] : [
          { label: "Total requests", value: dashboard?.total ?? 0, caption: "Campus maintenance records", icon: ClipboardList },
          { label: "Needs attention", value: dashboard?.by_status.Pending ?? 0, caption: isRequester ? "Awaiting review" : "Pending coordinator review", icon: Clock3 },
          { label: "In progress", value: (dashboard?.by_status.Assigned ?? 0) + (dashboard?.by_status["In Progress"] ?? 0), caption: "Assigned or being repaired", icon: Wrench },
          { label: "Completed", value: dashboard?.by_status.Completed ?? 0, caption: user.role === "requester" ? "Verified repairs" : `${dashboard?.urgent ?? 0} urgent active`, icon: CheckCircle2 },
        ]).map((metric) => <MetricCard key={metric.label} label={metric.label} value={metric.value} caption={metric.caption} icon={metric.icon} />)}
      </div>
      {pending.length > 0 && <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><span>{pending.length} report{pending.length > 1 ? "s are" : " is"} waiting to sync from this device.</span><button className="font-semibold underline" onClick={() => void synchronizePending().then(() => location.reload())}>Sync now</button></div>}
      {user.role === "requester" ? <RequesterOverview requests={requests} /> :
        user.role === "coordinator" ? <CoordinatorOverview requests={requests} /> :
          user.role === "technician" ? <TechnicianOverview orders={orders} /> :
            <AdministratorOverview data={dashboard} requests={requests} />}
    </div>
  );
}

function RequesterOverview({ requests }: { requests: MaintenanceRequest[] }) {
  return <section className="card">
    <div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold text-navy">Your recent reports</h3><p className="mt-1 text-xs text-slate-500">Updates appear as the maintenance team works through each request.</p></div><Link className="text-sm font-semibold text-teal" to="/requests">View all <ArrowUpRight className="inline" size={14} /></Link></div>
    {requests.length ? <RequestTable rows={requests.slice(0, 5)} /> : <EmptyState title="No reports yet" text="Submit your first maintenance request to get started." />}
  </section>;
}

function CoordinatorOverview({ requests }: { requests: MaintenanceRequest[] }) {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  useEffect(() => { dashboardApi.get().then(setData).catch(() => setData(null)); }, [user]);
  return <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
    <section className="card"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold text-navy">Incoming requests</h3><p className="mt-1 text-xs text-slate-500">Review new reports and route approved repairs.</p></div><Link to="/requests" className="text-sm font-semibold text-teal">Open queue <ArrowUpRight size={14} className="inline" /></Link></div><RequestTable rows={requests.filter((row) => row.status === "Pending").slice(0, 5)} /></section>
    <section className="card"><h3 className="font-semibold text-navy">Technician workload</h3><div className="mt-4 space-y-4">{(data?.technician_workload ?? []).map((item) => <div key={item.technician}><div className="mb-1.5 flex justify-between text-sm"><span>{item.technician}</span><span className="font-semibold">{item.active} active</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal" style={{ width: `${Math.min(100, item.active * 18)}%` }} /></div></div>)}</div></section>
  </div>;
}

function TechnicianOverview({ orders }: { orders: WorkOrder[] }) {
  return <section className="card"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold text-navy">Your current assignments</h3><p className="mt-1 text-xs text-slate-500">Progress is shared with the coordinator, administrator, and requester.</p></div><Link to="/work-orders" className="text-sm font-semibold text-teal">All assignments <ArrowUpRight size={14} className="inline" /></Link></div>{orders.length ? <WorkOrderCards orders={orders.slice(0, 4)} /> : <EmptyState title="No work orders assigned" text="New assignments will appear here as soon as they're routed to you." />}</section>;
}

function AdministratorOverview({ data, requests }: { data: DashboardData | null; requests: MaintenanceRequest[] }) {
  const categoryRows = Object.entries(data?.by_category ?? {}).sort((a, b) => b[1] - a[1]);
  return <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
    <section className="card"><h3 className="font-semibold text-navy">Requests by category</h3><div className="mt-5 space-y-4">{categoryRows.length ? categoryRows.map(([name, count]) => <div key={name}><div className="mb-1.5 flex justify-between text-sm"><span>{name}</span><span className="font-semibold">{count}</span></div><div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-teal" style={{ width: `${Math.max(7, count / Math.max(data?.total ?? 1, 1) * 100)}%` }} /></div></div>) : <EmptyState title="No category data yet" text="Submitted maintenance requests will appear in these analytics." />}</div></section>
    <section className="card"><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold text-navy">Latest campus activity</h3><p className="mt-1 text-xs text-slate-500">Most recently submitted maintenance requests.</p></div><Link to="/audit" className="text-sm font-semibold text-teal">Audit trail <ArrowUpRight size={14} className="inline" /></Link></div><RequestTable rows={requests.slice(0, 5)} /></section>
  </div>;
}

function RequestsPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<MaintenanceRequest[]>([]);
  const [technicians, setTechnicians] = useState<User[]>([]);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [catalog, setCatalog] = useState<CampusCatalog>({ categories: [], locations: [] });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(new URLSearchParams(window.location.search).has("new"));

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (query) params.set("search", query);
    if (statusFilter) params.set("status", statusFilter);
    if (categoryFilter) params.set("category", categoryFilter);
    if (locationFilter) params.set("location", locationFilter);
    requestsApi.list(params.size ? `?${params}` : "").then(setRows).catch((reason) => setError(reason.message));
  }, [query, statusFilter, categoryFilter, locationFilter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    dashboardApi.catalog().then(setCatalog).catch((reason) => setError(reason.message));
    if (user?.role === "coordinator") dashboardApi.users("technician").then(setTechnicians).catch((reason) => setError(reason.message));
    if (user?.role === "requester") listPending().then(setPending).catch((reason) => setError(reason.message));
  }, [user]);

  if (!user) return null;
  const canReview = user.role === "coordinator";
  const canCreate = user.role === "requester";

  async function review(request: MaintenanceRequest, decision: "approve" | "reject", technicianId?: number) {
    const remarks = window.prompt(decision === "approve" ? "Assignment or review remarks (optional):" : "Reason for declining this request:");
    if (remarks === null) return;
    setBusy(true);
    setError("");
    try {
      await requestsApi.review(request.id, {
        decision, priority: request.priority || "Medium", technician_id: technicianId,
        remarks, expected_version: request.version,
      });
      setMessage(`${request.public_id} ${decision === "approve" ? "approved and assigned" : "declined"}.`);
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review failed."); }
    finally { setBusy(false); }
  }

  async function cancel(request: MaintenanceRequest) {
    if (!window.confirm(`Cancel ${request.public_id}?`)) return;
    try { await requestsApi.cancel(request.id); setMessage(`${request.public_id} cancelled.`); load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Cancellation failed."); }
  }

  async function create(values: Record<string, string>, photo: File | null) {
    setBusy(true);
    setError("");
    setMessage("");
    const key = newOperationId();
    let request: MaintenanceRequest;
    try {
      request = await requestsApi.create(values, key);
    } catch (reason) {
      if (!(reason instanceof ApiError)) {
        try {
          await savePending(values, key, photo ?? undefined);
          setPending(await listPending());
          setMessage("Server unavailable. This report is saved on this device and will sync automatically.");
          setCreateOpen(false);
        } catch (storageError) {
          setError(storageError instanceof Error ? storageError.message : "This device could not save the offline request.");
        }
      } else setError(reason.message);
      setBusy(false);
      return;
    }
    if (photo) {
      try {
        await requestsApi.uploadPhoto(request.id, photo);
      } catch (reason) {
        try {
          await savePending(values, key, photo);
          setPending(await listPending());
          setMessage(`${request.public_id} was submitted. Its photo is queued for synchronization.`);
        } catch (storageError) {
          setError(`${request.public_id} was submitted, but the photo could not be uploaded or saved locally: ${storageError instanceof Error ? storageError.message : "storage error"}`);
        }
        setCreateOpen(false);
        load();
        setBusy(false);
        return;
      }
    }
    setMessage("Maintenance request sent to the coordinator.");
    setCreateOpen(false);
    load();
    setBusy(false);
  }

  return <div className="space-y-5">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><h2 className="text-2xl font-semibold text-navy">{canCreate ? "Your maintenance requests" : canReview ? "Incoming request queue" : "Campus requests"}</h2><p className="mt-1 text-sm text-slate-500">{canReview ? "Review reports and assign approved repairs to a technician." : "Track each issue through review, repair, and verification."}</p></div>    {canCreate && <button onClick={() => setCreateOpen(true)} className="button-primary"><Plus size={16} /> New request</button>}</div>
    {error && <ErrorBanner message={error} />}{message && <SuccessBanner message={message} />}
    {pending.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><div className="flex items-center justify-between"><div><div className="font-semibold">{pending.length} pending synchronization</div><div className="mt-1 text-xs">{pending.map((item) => item.values.title).join(" · ")}</div></div><button className="button-muted" onClick={() => void synchronizePending().then(() => { setPending([]); setMessage("Queued requests synchronized."); load(); }).catch((reason) => setError(reason.message))}>Sync now</button></div></div>}
    <section className="card">
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div className="relative"><Search className="absolute left-3 top-3 text-slate-400" size={16} /><input className="field pl-9" placeholder="Search request ID or title…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><select className="field" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option>{["Pending", "Assigned", "In Progress", "For Verification", "Completed", "Rejected", "Cancelled", "Reopened"].map((item) => <option key={item}>{item}</option>)}</select><select className="field" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All categories</option>{catalog.categories.map((item) => <option key={item.id}>{item.name}</option>)}</select><input className="field" placeholder="Building / location" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)} /></div>
      {canReview ? <CoordinatorQueue rows={rows} technicians={technicians} busy={busy} onReview={review} /> : <RequestTable rows={rows} onCancel={canCreate ? cancel : undefined} />}
    </section>
    {createOpen && <RequestDialog busy={busy} categories={catalog.categories} locations={catalog.locations} onClose={() => setCreateOpen(false)} onSubmit={create} />}
  </div>;
}

function CoordinatorQueue({ rows, technicians, busy, onReview }: { rows: MaintenanceRequest[]; technicians: User[]; busy: boolean; onReview: (row: MaintenanceRequest, decision: "approve" | "reject", id?: number) => void }) {
  const [assignments, setAssignments] = useState<Record<number, string>>({});
  const [priorities, setPriorities] = useState<Record<number, string>>({});
  return <div className="space-y-3">
    {rows.length ? rows.map((row) => <article key={row.id} className="rounded-xl border border-slate-100 p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row"><div><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-navy">{row.title}</span><StatusBadge status={row.status} /><span className="text-xs text-slate-400">{row.public_id}</span></div><p className="mt-2 max-w-3xl text-sm text-slate-600">{row.description}</p><div className="mt-2 text-xs text-slate-500">{row.category} · {row.building}{row.room ? ` · Room ${row.room}` : ""} · {row.requester_name}</div>{row.attachments.length > 0 && <AttachmentLinks attachments={row.attachments} />}</div></div>
      {row.status === "Pending" && <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-center"><select className="field sm:max-w-64" value={assignments[row.id] ?? ""} onChange={(event) => setAssignments({ ...assignments, [row.id]: event.target.value })}><option value="">Choose technician…</option>{technicians.map((tech) => <option key={tech.id} value={tech.id}>{tech.name}</option>)}</select><select className="field sm:max-w-40" aria-label="Priority" value={priorities[row.id] ?? row.priority} onChange={(event) => setPriorities({ ...priorities, [row.id]: event.target.value })}><option>Low</option><option>Medium</option><option>High</option><option>Urgent</option></select><button disabled={busy || !assignments[row.id]} className="button-primary" onClick={() => onReview({ ...row, priority: priorities[row.id] ?? row.priority }, "approve", Number(assignments[row.id]))}><Check size={15} /> Approve & assign</button><button disabled={busy} className="button-muted text-rose-700" onClick={() => onReview({ ...row, priority: priorities[row.id] ?? row.priority }, "reject")}><X size={15} /> Decline</button></div>}
      {row.review_remarks && <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600"><b>Review notes:</b> {row.review_remarks}</div>}
    </article>) : <EmptyState title="Queue is clear" text="Newly submitted requests will arrive here in real time." />}
  </div>;
}

function RequestDialog({ busy, categories, locations, onClose, onSubmit }: {
  busy: boolean;
  categories: CatalogItem[];
  locations: CatalogItem[];
  onClose: () => void;
  onSubmit: (data: Record<string, string>, photo: File | null) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries([...form.entries()].filter(([key]) => key !== "photo")) as Record<string, string>;
    const photo = form.get("photo");
    onSubmit(values, photo instanceof File && photo.size ? photo : null);
  }
  return <div className="fixed inset-0 z-40 grid place-items-center bg-navy/45 p-4">
    <form onSubmit={submit} className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
      <div className="mb-5 flex items-start justify-between"><div><h3 className="text-xl font-semibold text-navy">Report a maintenance issue</h3><p className="mt-1 text-sm text-slate-500">Your report is sent to the campus coordinator.</p></div><button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close"><X size={19} /></button></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Request title" name="title" required minLength={4} maxLength={180} placeholder="e.g. Projector not turning on" /></div>
        <div><label className="label" htmlFor="category">Category</label><select className="field" id="category" name="category" required><option value="">Select category</option>{categories.map((item) => <option key={item.id}>{item.name}</option>)}</select></div>
        <div><label className="label" htmlFor="building">Building / location</label><select className="field" id="building" name="building" required defaultValue=""><option value="" disabled>Select campus location</option>{locations.map((item) => <option key={item.id}>{item.name}</option>)}</select></div>
        <Field label="Room number (optional)" name="room" placeholder="e.g. Room 204" />
        <div className="sm:col-span-2"><label className="label" htmlFor="description">Describe the issue</label><textarea className="field min-h-28 resize-y" id="description" name="description" required minLength={10} maxLength={5000} placeholder="What is damaged, when did it start, and is anything unsafe?" /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="photo">Photo (optional, JPEG/PNG/WebP up to 5 MB)</label><input className="field file:mr-3 file:rounded-lg file:border-0 file:bg-teal-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-teal" id="photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" /></div>
      </div>
      <div className="mt-5 flex justify-end gap-2"><button type="button" className="button-muted" onClick={onClose}>Cancel</button><button disabled={busy} className="button-primary"><Plus size={15} /> {busy ? "Sending…" : "Submit request"}</button></div>
    </form>
  </div>;
}

function WorkOrdersPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [technicians, setTechnicians] = useState<User[]>([]);
  const load = useCallback(() => workOrdersApi.list().then(setOrders).catch((reason) => setError(reason.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (user?.role === "coordinator") dashboardApi.users("technician").then(setTechnicians).catch((reason) => setError(reason.message));
  }, [user]);
  if (!user) return null;
  const admin = user.role === "administrator";
  const coordinator = user.role === "coordinator";
  const visible = admin ? orders.filter((order) => order.status === "For Verification" || order.status === "Reopened") : orders;

  async function update(order: WorkOrder, note: string, verify: boolean, photo?: File) {
    setBusyId(order.id); setError(""); setMessage("");
    try {
      if (photo) {
        await workOrdersApi.uploadPhoto(order.id, photo);
      }
      await workOrdersApi.update(order.id, note, verify);
      setMessage(verify ? `${order.public_id} submitted for verification.` : `${order.public_id} progress saved.`);
      load();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Work order update failed."); }
    finally { setBusyId(null); }
  }
  async function verify(order: WorkOrder, verified: boolean) {
    const remarks = window.prompt(verified ? "Verification remarks:" : "Describe the work still required:");
    if (remarks === null) return;
    setBusyId(order.id); setError(""); setMessage("");
    try { await workOrdersApi.verify(order.id, verified, remarks, order.version); setMessage(verified ? `${order.public_id} verified and completed.` : `${order.public_id} returned for additional work.`); load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Verification failed."); }
    finally { setBusyId(null); }
  }
  async function accept(order: WorkOrder) {
    setBusyId(order.id); setError(""); setMessage("");
    try {
      await workOrdersApi.accept(order.id, order.version);
      setMessage(`${order.public_id} accepted. You can now update repair progress.`);
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Assignment acceptance failed."); }
    finally { setBusyId(null); }
  }
  async function reassign(order: WorkOrder, technicianId: number) {
    setBusyId(order.id); setError(""); setMessage("");
    try {
      await workOrdersApi.reassign(order.id, technicianId, order.version);
      setMessage(`${order.public_id} reassigned.`);
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Reassignment failed."); }
    finally { setBusyId(null); }
  }

  return <div className="space-y-5"><div><h2 className="text-2xl font-semibold text-navy">{admin ? "Repair verification" : coordinator ? "Campus work orders" : "My work orders"}</h2><p className="mt-1 text-sm text-slate-500">{admin ? "Check technician reports and approve the final repair or send it back." : coordinator ? "Monitor assignments and current repair progress." : "Accept assignments, record repair notes, and submit finished work for verification."}</p></div>{error && <ErrorBanner message={error} />}{message && <SuccessBanner message={message} />}
    <WorkOrderCards orders={visible} mode={admin ? "verify" : user.role === "technician" ? "technician" : coordinator ? "coordinator" : "read"} technicians={technicians} busyId={busyId} onAccept={accept} onUpdate={update} onVerify={verify} onReassign={reassign} />
  </div>;
}

function WorkOrderCards({ orders, mode = "read", technicians = [], busyId, onAccept, onUpdate, onVerify, onReassign }: {
  orders: WorkOrder[]; mode?: "verify" | "technician" | "coordinator" | "read"; technicians?: User[]; busyId?: number | null;
  onAccept?: (order: WorkOrder) => void;
  onUpdate?: (order: WorkOrder, note: string, submit: boolean, photo?: File) => void;
  onVerify?: (order: WorkOrder, verified: boolean) => void;
  onReassign?: (order: WorkOrder, technicianId: number) => void;
}) {
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [photos, setPhotos] = useState<Record<number, File | undefined>>({});
  const [newTechnicians, setNewTechnicians] = useState<Record<number, string>>({});
  if (!orders.length) return <EmptyState title="Nothing to show" text="New assignments and repair updates will appear here." />;
  return <div className="grid gap-4 xl:grid-cols-2">{orders.map((order) => <article key={order.id} className="card">
    <div className="flex items-start justify-between gap-3"><div><div className="text-xs font-semibold text-teal">{order.public_id} · {order.request_id}</div><h3 className="mt-1 text-lg font-semibold text-navy">{order.title}</h3><div className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge status={order.status} /><span className="text-xs text-slate-500">{order.priority} priority</span></div></div><Wrench className="text-teal" size={20} /></div>
    <p className="mt-3 text-sm leading-6 text-slate-600">{order.description}</p>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500"><span>{order.category}</span><span>{order.building}{order.room ? ` · ${order.room}` : ""}</span><span>Requester: {order.requester_name}</span>{mode !== "technician" && <span>Technician: {order.technician_name}</span>}</div>
    <div className="mt-4 border-t border-slate-100 pt-3"><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Repair timeline</div>{order.updates.length ? <div className="max-h-28 space-y-2 overflow-y-auto">{order.updates.slice().reverse().map((item) => <div key={item.id} className="rounded-lg bg-slate-50 px-3 py-2 text-xs"><span className="font-semibold text-slate-700">{item.author_name}</span><span className="ml-2 text-slate-400">{new Date(item.created_at).toLocaleString()}</span><p className="mt-1 text-slate-600">{item.note}</p></div>)}</div> : <p className="text-xs text-slate-400">No repair notes recorded yet.</p>}{order.attachments.length > 0 && <AttachmentLinks attachments={order.attachments} />}</div>
    {mode === "technician" && order.status === "Assigned" && <div className="mt-4 flex justify-end"><button className="button-primary" disabled={busyId === order.id} onClick={() => onAccept?.(order)}><Check size={15} /> Accept assignment</button></div>}
    {mode === "technician" && ["In Progress", "Reopened"].includes(order.status) && <div className="mt-4 space-y-2"><textarea className="field min-h-20" placeholder="Describe the repair progress or work performed…" value={notes[order.id] ?? ""} onChange={(event) => setNotes({ ...notes, [order.id]: event.target.value })} /><input className="field file:mr-3 file:rounded-lg file:border-0 file:bg-teal-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-teal" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Repair evidence photo" onChange={(event) => setPhotos({ ...photos, [order.id]: event.target.files?.[0] })} /><div className="flex justify-end"><button className="button-primary" disabled={busyId === order.id || (notes[order.id] ?? "").trim().length < 3} onClick={() => onUpdate?.(order, notes[order.id], false, photos[order.id])}><Wrench size={15} /> Save progress</button><button className="button-primary ml-2 bg-navy hover:bg-navy/90" disabled={busyId === order.id || (notes[order.id] ?? "").trim().length < 3} onClick={() => onUpdate?.(order, notes[order.id], true, photos[order.id])}><CheckCircle2 size={15} /> Submit for review</button></div></div>}
    {mode === "verify" && order.status === "For Verification" && <div className="mt-4 flex justify-end gap-2"><button className="button-muted text-rose-700" disabled={busyId === order.id} onClick={() => onVerify?.(order, false)}>Return for rework</button><button className="button-primary" disabled={busyId === order.id} onClick={() => onVerify?.(order, true)}><Check size={15} /> Verify repair</button></div>}
    {mode === "coordinator" && ["Assigned", "In Progress", "Reopened"].includes(order.status) && <div className="mt-4 flex flex-col gap-2 sm:flex-row"><select className="field sm:max-w-64" aria-label="Reassign technician" value={newTechnicians[order.id] ?? ""} onChange={(event) => setNewTechnicians({ ...newTechnicians, [order.id]: event.target.value })}><option value="">Reassign technician…</option>{technicians.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select><button className="button-muted" disabled={busyId === order.id || !newTechnicians[order.id]} onClick={() => onReassign?.(order, Number(newTechnicians[order.id]))}>Save reassignment</button></div>}
  </article>)}</div>;
}

function TeamPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [categories, setCategories] = useState<CatalogItem[]>([]);
  const [locations, setLocations] = useState<CatalogItem[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => dashboardApi.users().then(setUsers).catch((reason) => setError(reason.message)), []);
  const loadCatalog = useCallback(() => Promise.all([
    dashboardApi.allCatalog("categories"),
    dashboardApi.allCatalog("locations"),
  ]).then(([categoryRows, locationRows]) => {
    setCategories(categoryRows);
    setLocations(locationRows);
  }).catch((reason) => setError(reason.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const formElement = event.currentTarget;
    const values = Object.fromEntries(new FormData(formElement).entries()) as Record<string, string>;
    try {
      await dashboardApi.createUser({ name: values.name, email: values.email, password: values.password, role: values.role });
      formElement.reset();
      setMessage("Account created and role access applied.");
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "User creation failed."); }
    finally { setBusy(false); }
  }
  async function toggleActive(account: User) {
    setError(""); setMessage("");
    try {
      await dashboardApi.setUserActive(account.id, !account.is_active);
      setMessage(`${account.name} was ${account.is_active ? "deactivated" : "reactivated"}.`);
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Account update failed."); }
  }
  async function addCatalogItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    try {
      await dashboardApi.createCatalogItem(values.kind as "categories" | "locations", values.name);
      form.reset();
      setMessage(`${values.kind === "categories" ? "Category" : "Location"} added.`);
      await loadCatalog();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Catalog update failed."); }
    finally { setBusy(false); }
  }
  async function toggleCatalog(kind: "categories" | "locations", item: CatalogItem) {
    setError(""); setMessage("");
    try {
      await dashboardApi.setCatalogActive(kind, item.id, !item.is_active);
      setMessage(`${item.name} ${item.is_active ? "deactivated" : "activated"}.`);
      await loadCatalog();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Catalog update failed."); }
  }
  const catalogGroups: { kind: "categories" | "locations"; label: string; items: CatalogItem[] }[] = [
    { kind: "categories", label: "Maintenance categories", items: categories },
    { kind: "locations", label: "Campus locations", items: locations },
  ];
  return <div className="space-y-5"><div><h2 className="text-2xl font-semibold text-navy">Team & accounts</h2><p className="mt-1 text-sm text-slate-500">Create and review role-based accounts, categories, and campus location suggestions. New public registrations are requesters only.</p></div>{error && <ErrorBanner message={error} />}{message && <SuccessBanner message={message} />}
    <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]"><form onSubmit={submit} className="card h-fit"><h3 className="mb-4 font-semibold text-navy">Create a campus account</h3><div className="space-y-4"><Field label="Full name" name="name" required minLength={2} /><Field label="Email" name="email" type="email" required /><Field label="Temporary password" name="password" type="password" required minLength={10} /><div><label className="label">Role</label><select className="field" name="role" required><option value="requester">Requester</option><option value="coordinator">Coordinator</option><option value="technician">Technician</option><option value="administrator">Administrator</option></select></div><button className="button-primary w-full" disabled={busy}><Plus size={15} /> {busy ? "Creating…" : "Create account"}</button></div></form>
    <section className="card"><h3 className="mb-4 font-semibold text-navy">Campus accounts <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{users.length}</span></h3><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase tracking-wide text-slate-400"><tr><th className="pb-3">Name</th><th className="pb-3">Email</th><th className="pb-3">Role</th><th className="pb-3">Access</th><th className="pb-3"></th></tr></thead><tbody className="divide-y divide-slate-100">{users.map((item) => <tr key={item.id}><td className="py-3 font-medium text-slate-700">{item.name}</td><td className="py-3 text-slate-500">{item.email}</td><td className="py-3"><span className="rounded-full bg-teal-50 px-2.5 py-1 text-xs capitalize text-teal-800">{roleLabels[item.role]}</span></td><td className="py-3"><span className={`text-xs font-semibold ${item.is_active ? "text-emerald-700" : "text-slate-400"}`}>{item.is_active ? "Active" : "Disabled"}</span></td><td className="py-3 text-right"><button onClick={() => void toggleActive(item)} className={`text-xs font-semibold ${item.is_active ? "text-rose-600" : "text-teal"}`}>{item.is_active ? "Disable" : "Enable"}</button></td></tr>)}</tbody></table></div></section></div>
    <form onSubmit={addCatalogItem} className="card"><h3 className="font-semibold text-navy">Add category or location</h3><div className="mt-4 grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"><div><label className="label">Catalog type</label><select className="field" name="kind"><option value="categories">Maintenance category</option><option value="locations">Campus location</option></select></div><Field label="Name" name="name" required minLength={2} maxLength={120} placeholder="e.g. Residence Hall" /><button className="button-primary" disabled={busy}><Plus size={15} /> Add option</button></div><p className="mt-2 text-xs text-slate-400">Deactivating an option hides it from new request forms; existing maintenance records keep their saved values.</p></form>
    <div className="grid gap-5 xl:grid-cols-2">{catalogGroups.map((group) => <section key={group.kind} className="card"><h3 className="mb-3 font-semibold text-navy">{group.label}</h3><div className="divide-y divide-slate-100">{group.items.map((item) => <div key={item.id} className="flex items-center justify-between py-2.5 text-sm"><span className={item.is_active ? "text-slate-700" : "text-slate-400"}>{item.name}</span><button onClick={() => void toggleCatalog(group.kind, item)} className={`text-xs font-semibold ${item.is_active ? "text-rose-600" : "text-teal"}`}>{item.is_active ? "Deactivate" : "Activate"}</button></div>)}</div></section>)}</div>
  </div>;
}

function StationsPage() {
  const [stations, setStations] = useState<Station[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(() => dashboardApi.stations().then(setStations).catch((reason) => setError(reason.message)), []);
  useEffect(() => { load(); const interval = window.setInterval(load, 15000); return () => window.clearInterval(interval); }, [load]);
  return <div className="space-y-5"><div><h2 className="text-2xl font-semibold text-navy">Connected stations</h2><p className="mt-1 text-sm text-slate-500">Laptop heartbeat status updates every 12 seconds; a station is offline after 45 seconds without contact.</p></div>{error && <ErrorBanner message={error} />}<section className="card"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{stations.map((station) => <div key={station.station_id} className="rounded-xl border border-slate-100 p-4"><div className="flex items-center justify-between"><span className="rounded-lg bg-slate-100 p-2"><Radio size={16} className="text-teal" /></span><span className={`inline-flex items-center gap-1 text-xs font-semibold ${station.connected ? "text-emerald-700" : "text-rose-600"}`}><span className={`h-2 w-2 rounded-full ${station.connected ? "bg-emerald-500" : "bg-rose-500"}`} />{station.connected ? "Online" : "Offline"}</span></div><div className="mt-3 font-semibold text-navy">{station.user_name}</div><div className="mt-0.5 text-xs capitalize text-slate-500">{station.role} · {station.station_id}</div><div className="mt-2 text-[11px] text-slate-400">Last seen {new Date(station.last_seen_at).toLocaleString()}</div></div>)}</div>{!stations.length && <EmptyState title="No stations registered yet" text="Signed-in role laptops will appear after the first heartbeat." />}</section></div>;
}

function ReportsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState("");
  const [location, setLocation] = useState("");
  const [technicianId, setTechnicianId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [technicians, setTechnicians] = useState<User[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (user?.role === "coordinator" || user?.role === "administrator") {
      dashboardApi.users("technician").then(setTechnicians).catch((reason) => setError(reason.message));
    }
  }, [user]);
  async function exportCsv() {
    setError("");
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (location) params.set("location", location);
      if (technicianId) params.set("technician_id", technicianId);
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      const response = await fetch(`${apiBase}/reports/maintenance.csv?${params}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!response.ok) throw new Error((await response.json()).detail ?? "Report export failed.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = "maintenance-report.csv"; link.click();
      URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Report export failed."); }
  }
  if (user?.role === "requester" || user?.role === "technician") return <Navigate to="/" replace />;
  return <div className="space-y-5"><div><h2 className="text-2xl font-semibold text-navy">Maintenance reports</h2><p className="mt-1 text-sm text-slate-500">Export filtered maintenance records from the shared central database.</p></div>{error && <ErrorBanner message={error} />}<section className="card"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><div><label className="label">Status</label><select className="field" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{["Pending", "Assigned", "In Progress", "For Verification", "Completed", "Rejected", "Cancelled", "Reopened"].map((item) => <option key={item}>{item}</option>)}</select></div><Field label="Building / location" value={location} onChange={setLocation} placeholder="Any building" /><div><label className="label">Technician</label><select className="field" value={technicianId} onChange={(event) => setTechnicianId(event.target.value)}><option value="">All technicians</option>{technicians.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div><label className="label">From date</label><input className="field" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></div><div><label className="label">To date</label><input className="field" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></div><div className="flex items-end"><button className="button-primary w-full" onClick={() => void exportCsv()}><ArrowDownToLine size={16} /> Download CSV</button></div></div></section></div>;
}

function AuditPage() {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { dashboardApi.audit().then(setItems).catch((reason) => setError(reason.message)); }, []);
  return <div className="space-y-5"><div><h2 className="text-2xl font-semibold text-navy">Audit trail</h2><p className="mt-1 text-sm text-slate-500">Timestamped account and workflow activity from the central database.</p></div>{error && <ErrorBanner message={error} />}<section className="card overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400"><tr>{["Time", "Actor", "Action", "Record", "Details"].map((item) => <th className="pb-3 pr-4" key={item}>{item}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{items.map((item) => <tr key={item.id}><td className="py-3 pr-4 text-xs text-slate-500">{new Date(item.created_at).toLocaleString()}</td><td className="py-3 pr-4 font-medium">{item.actor}</td><td className="py-3 pr-4">{item.action}</td><td className="py-3 pr-4">{item.entity_type} · {item.entity_id}</td><td className="py-3 pr-4 text-xs text-slate-500">{item.details}</td></tr>)}</tbody></table>{!items.length && <EmptyState title="No activity recorded yet" text="Workflow events will be recorded here." />}</section></div>;
}

function ProfilePage() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try { const updated = await api<User>(`/auth/profile?name=${encodeURIComponent(name)}`, { method: "PATCH" }); setUser(updated); setMessage("Profile saved."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Profile update failed."); }
  }
  return <div className="max-w-2xl space-y-5"><div><h2 className="text-2xl font-semibold text-navy">Profile</h2><p className="mt-1 text-sm text-slate-500">Update the name shown to other campus staff.</p></div>{error && <ErrorBanner message={error} />}{message && <SuccessBanner message={message} />}<form onSubmit={submit} className="card space-y-4"><Field label="Full name" value={name} onChange={setName} required minLength={2} /><Field label="Email address" value={user?.email ?? ""} disabled /><button className="button-primary">Save profile</button></form></div>;
}

function NotificationsPanel({ items, onRefresh }: { items: NotificationItem[]; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  async function read(id: number) {
    try { await api<void>(`/notifications/${id}/read`, { method: "POST" }); await onRefresh(); }
    catch { await onRefresh(); }
  }
  return <div className="fixed bottom-5 right-5 z-20">
    {open && <div className="mb-3 w-[min(360px,calc(100vw-2.5rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"><div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><div className="font-semibold text-navy">Notifications <span className="ml-1 text-xs font-normal text-slate-400">{items.filter((item) => !item.read_at).length} new</span></div><button aria-label="Close notifications" onClick={() => setOpen(false)}><X size={17} /></button></div><div className="max-h-80 overflow-y-auto">{items.length ? items.slice(0, 30).map((item) => <button key={item.id} onClick={() => void read(item.id)} className={`block w-full border-b border-slate-50 px-4 py-3 text-left hover:bg-slate-50 ${item.read_at ? "opacity-60" : ""}`}><div className="text-sm font-semibold text-slate-700">{item.title}</div><p className="mt-1 text-xs text-slate-500">{item.message}</p><div className="mt-1 text-[10px] text-slate-400">{new Date(item.created_at).toLocaleString()}</div></button>) : <div className="p-6 text-center text-sm text-slate-400">No notifications yet.</div>}</div></div>}
    <button onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-full bg-navy px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-navy/90"><Bell size={17} /> Notifications{items.some((item) => !item.read_at) && <span className="h-2 w-2 rounded-full bg-teal-300" />}</button>
  </div>;
}

function RequestTable({ rows, onCancel }: { rows: MaintenanceRequest[]; onCancel?: (row: MaintenanceRequest) => void }) {
  if (!rows.length) return <EmptyState title="No requests match" text="Try changing your search or filters." />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400"><tr>{["Request", "Category / location", "Priority", "Status", "Submitted", ""].map((item, index) => <th key={`${item}${index}`} className="pb-3 pr-3">{item}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.map((row) => <tr key={row.id}><td className="py-3 pr-3"><div className="font-semibold text-slate-700">{row.title}</div><div className="mt-0.5 text-[11px] text-slate-400">{row.public_id}{row.technician_name ? ` · ${row.technician_name}` : ""}</div>{row.attachments.length > 0 && <AttachmentLinks attachments={row.attachments} />}</td><td className="py-3 pr-3"><div className="text-slate-600">{row.category}</div><div className="text-xs text-slate-400">{row.building}{row.room ? ` · ${row.room}` : ""}</div></td><td className="py-3 pr-3"><PriorityBadge priority={row.priority} /></td><td className="py-3 pr-3"><StatusBadge status={row.status} /></td><td className="py-3 pr-3 text-xs text-slate-500">{new Date(row.created_at).toLocaleDateString()}</td><td className="py-3 text-right">{onCancel && row.status === "Pending" && <button onClick={() => onCancel(row)} className="text-xs font-semibold text-rose-600 hover:underline">Cancel</button>}</td></tr>)}</tbody></table></div>;
}

function AttachmentLinks({ attachments }: { attachments: { public_id: string; filename: string }[] }) {
  const [error, setError] = useState("");
  return <div className="mt-2 flex flex-wrap items-center gap-2">{attachments.map((item) => <button key={item.public_id} onClick={() => {
    setError("");
    openAttachment(item.public_id).catch((reason) => setError(reason instanceof Error ? reason.message : "Attachment could not be opened."));
  }} className="text-xs font-semibold text-teal hover:underline">{item.filename}</button>)}{error && <span role="alert" className="text-xs text-rose-600">{error}</span>}</div>;
}

function MetricCard({ label, value, caption, icon: Icon }: { label: string; value: number; caption: string; icon: typeof Activity }) {
  return <div className="card"><div className="flex items-start justify-between"><div><div className="text-sm text-slate-500">{label}</div><div className="mt-2 text-3xl font-semibold tracking-tight text-navy">{value}</div></div><span className="rounded-xl bg-teal-50 p-2.5 text-teal"><Icon size={19} /></span></div><div className="mt-3 text-xs text-slate-400">{caption}</div></div>;
}

function StatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    Pending: "bg-amber-50 text-amber-700", "Under Review": "bg-blue-50 text-blue-700",
    Assigned: "bg-violet-50 text-violet-700", "In Progress": "bg-sky-50 text-sky-700",
    "For Verification": "bg-teal-50 text-teal-800", Completed: "bg-emerald-50 text-emerald-700",
    Rejected: "bg-rose-50 text-rose-700", Cancelled: "bg-slate-100 text-slate-600",
    Reopened: "bg-orange-50 text-orange-700",
  };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${classes[status] ?? "bg-slate-100 text-slate-600"}`}>{status}</span>;
}

function PriorityBadge({ priority }: { priority: string }) {
  const color = priority === "Urgent" ? "text-rose-700" : priority === "High" ? "text-orange-700" : priority === "Low" ? "text-slate-500" : "text-slate-600";
  return <span className={`inline-flex items-center gap-1 text-xs font-semibold ${color}`}>{priority === "Urgent" && <AlertCircle size={13} />}{priority}</span>;
}

function Field(props: {
  label: string; name?: string; type?: string; value?: string; onChange?: (value: string) => void;
  placeholder?: string; required?: boolean; minLength?: number; maxLength?: number; disabled?: boolean; list?: string;
}) {
  const { label, onChange, ...inputProps } = props;
  return <div className="w-full"><label className="label" htmlFor={props.name ?? label}>{label}</label><input id={props.name ?? label} className="field" {...inputProps} onChange={onChange ? (event) => onChange(event.target.value) : undefined} /></div>;
}

function Brand({ light = false }: { light?: boolean }) {
  return <div className="flex items-center gap-2.5"><span className={`grid h-9 w-9 place-items-center rounded-xl ${light ? "bg-teal-400/15 text-teal-200" : "bg-teal-50 text-teal"}`}><Wrench size={19} /></span><div><div className={`font-semibold leading-5 ${light ? "text-white" : "text-navy"}`}>CampusCare</div><div className={`text-[10px] tracking-wide ${light ? "text-slate-400" : "text-slate-400"}`}>MAINTENANCE OPERATIONS</div></div></div>;
}

function ErrorBanner({ message }: { message: string }) {
  return <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><AlertCircle className="mt-0.5 shrink-0" size={16} /><span>{message}</span></div>;
}

function SuccessBanner({ message }: { message: string }) {
  return <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"><CheckCircle2 className="mt-0.5 shrink-0" size={16} /><span>{message}</span></div>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center"><div><div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-white text-slate-400 shadow-sm"><ClipboardList size={18} /></div><div className="mt-3 text-sm font-semibold text-slate-700">{title}</div><p className="mt-1 text-xs text-slate-500">{text}</p></div></div>;
}

function dashboardSubheading(role: Role) {
  if (role === "requester") return "Report issues and stay updated as campus repairs progress.";
  if (role === "coordinator") return "Triage incoming reports and route repairs to the right people.";
  if (role === "technician") return "Manage assigned maintenance work and share repair progress.";
  return "Monitor maintenance activity and verify completed repairs.";
}

export default App;
