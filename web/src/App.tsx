import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './session';
import { I18nProvider } from './i18n';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { LoginPage, ChangePasswordPage } from './pages/Auth';
import { DeskPage } from './pages/Desk';
import { PluginPage } from './pages/Plugin';
import { Onboarding } from './components/Onboarding';

const ProjectsPage = lazy(() => import('./pages/Projects'));
const CrmPage = lazy(() => import('./pages/Crm'));
const ToolPages = lazy(() => import('./pages/ToolPages'));
const CrmAccountPage = lazy(() => import('./pages/CrmAccount'));
const ProjectPage = lazy(() => import('./pages/Project'));
const TeamPage = lazy(() => import('./pages/Team'));
const InboxPage = lazy(() => import('./pages/Inbox'));
const NotesPage = lazy(() => import('./pages/Notes'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const CadPage = lazy(() => import('./pages/Cad'));
const PcbPage = lazy(() => import('./pages/Pcb'));
const AppStorePage = lazy(() => import('./pages/AppStore'));
const MeetingsPage = lazy(() => import('./pages/Meetings'));
const MeetPage = lazy(() => import('./pages/Meet'));
const PhonePage = lazy(() => import('./pages/Phone'));
const FormsPage = lazy(() => import('./pages/Forms'));
const BoardPage = lazy(() => import('./pages/Board'));
const Viewer3DPage = lazy(() => import('./pages/Viewer3DPage'));
const MindmapsPage = lazy(() => import('./pages/Mindmaps'));
const KnowledgePage = lazy(() => import('./pages/Knowledge'));
const WarehousePage = lazy(() => import('./pages/Warehouse'));
const InventoryPage = lazy(() => import('./pages/Inventory'));
const FinancePage = lazy(() => import('./pages/Finance'));
const PayrollPage = lazy(() => import('./pages/Payroll'));
const MaintenancePage = lazy(() => import('./pages/Maintenance'));
const QualityPage = lazy(() => import('./pages/Quality'));
const ManufacturingPage = lazy(() => import('./pages/Manufacturing'));
const PlmPage = lazy(() => import('./pages/Plm'));
const ServicePage = lazy(() => import('./pages/Service'));
const HelpdeskPage = lazy(() => import('./pages/Helpdesk'));
const ContractsPage = lazy(() => import('./pages/Contracts'));
const BookingPage = lazy(() => import('./pages/Booking'));
const EventsPage = lazy(() => import('./pages/Events'));
const PublicSupportPage = lazy(() => import('./pages/Helpdesk').then((m) => ({ default: m.PublicSupportPage })));
const PublicBookingPage = lazy(() => import('./pages/Booking').then((m) => ({ default: m.PublicBookingPage })));
const PublicEventPage = lazy(() => import('./pages/Events').then((m) => ({ default: m.PublicEventPage })));
const MyPayslipsPage = lazy(() => import('./pages/Payroll').then((m) => ({ default: m.MyPayslipsPage })));
const PublicKbPage = lazy(() => import('./pages/Knowledge').then((m) => ({ default: m.PublicKbPage })));
const PublicFormPage = lazy(() => import('./pages/Forms').then((m) => ({ default: m.PublicFormPage })));
const TimePage = lazy(() => import('./pages/Time'));
const AbsencesPage = lazy(() => import('./pages/Absences'));
const CalendarPage = lazy(() => import('./pages/Calendar'));
const ChatPage = lazy(() => import('./pages/Chat'));
const MailPage = lazy(() => import('./pages/Mail'));
const KvpPage = lazy(() => import('./pages/Kvp'));
const SharePage = lazy(() => import('./pages/Share'));
const ResourcesPage = lazy(() => import('./pages/Resources'));
const OfficePage = lazy(() => import('./pages/Office'));

export function App() {
  const { me, loading } = useSession();
  const lang = me?.locale ?? (navigator.language.startsWith('de') ? 'de' : 'en');

  // Öffentliche Freigabelinks funktionieren ohne Anmeldung
  // Meeting-Gäste ohne Benutzerkonto
  if (location.pathname.startsWith('/meet/')) {
    return <I18nProvider lang={lang}><Suspense fallback={<Loading />}><MeetPage /></Suspense></I18nProvider>;
  }
  if (location.pathname.startsWith('/form/')) {
    return <I18nProvider lang={lang}><Suspense fallback={<Loading />}><PublicFormPage /></Suspense></I18nProvider>;
  }
  if (location.pathname.startsWith('/kb/')) {
    return <I18nProvider lang={lang}><Suspense fallback={<Loading />}><PublicKbPage /></Suspense></I18nProvider>;
  }
  if (location.pathname.startsWith('/support')) return <Suspense fallback={<Loading />}><PublicSupportPage /></Suspense>;
  if (location.pathname.startsWith('/book/')) return <Suspense fallback={<Loading />}><PublicBookingPage /></Suspense>;
  if (location.pathname.startsWith('/event/')) return <Suspense fallback={<Loading />}><PublicEventPage /></Suspense>;
  if (location.pathname.startsWith('/s/')) {
    return <I18nProvider lang={lang}><Suspense fallback={<Loading />}><SharePage /></Suspense></I18nProvider>;
  }
  if (loading) return <Loading />;
  if (!me) return <I18nProvider lang={lang}><LoginPage /></I18nProvider>;
  if (me.mustChangePassword) return <I18nProvider lang={lang}><ChangePasswordPage forced /></I18nProvider>;
  if (location.pathname.startsWith('/office/')) return <Suspense fallback={<Loading />}><OfficePage /></Suspense>;

  return (
    <I18nProvider lang={lang}>
      <Layout>
        {!me.onboarded && me.role !== 'guest' && <Onboarding />}
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<DeskPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/teams/:id" element={<TeamPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/cad" element={<CadPage />} />
            <Route path="/cad-bridge" element={<Navigate to="/cad" replace />} />
            <Route path="/pcb" element={<PcbPage />} />
            <Route path="/apps" element={<AppStorePage />} />
            <Route path="/meetings" element={<MeetingsPage />} />
            <Route path="/meetings/:id" element={<MeetingsPage />} />
            <Route path="/phone" element={<PhonePage />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/viewer3d" element={<Viewer3DPage />} />
            <Route path="/warehouse" element={<WarehousePage />} />
            <Route path="/warehouse/:kind/:id" element={<WarehousePage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/inventory/:id" element={<InventoryPage />} />
            <Route path="/finance" element={<FinancePage />} />
            <Route path="/payroll" element={<PayrollPage />} />
            <Route path="/payslips" element={<MyPayslipsPage />} />
            <Route path="/maintenance" element={<MaintenancePage />} />
            <Route path="/quality" element={<QualityPage />} />
            <Route path="/manufacturing" element={<ManufacturingPage />} />
            <Route path="/plm" element={<PlmPage />} />
            <Route path="/service" element={<ServicePage />} />
            <Route path="/helpdesk" element={<HelpdeskPage />} />
            <Route path="/contracts" element={<ContractsPage />} />
            <Route path="/booking" element={<BookingPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/knowledge/:id" element={<KnowledgePage />} />
            <Route path="/mindmaps" element={<MindmapsPage />} />
            <Route path="/mindmaps/:id" element={<MindmapsPage />} />
            <Route path="/forms" element={<FormsPage />} />
            <Route path="/forms/:id" element={<FormsPage />} />
            <Route path="/forms/:id/:mode" element={<FormsPage />} />
            <Route path="/time" element={<TimePage />} />
            <Route path="/absences" element={<AbsencesPage />} />
            <Route path="/crm" element={<CrmPage />} />
            <Route path="/purchasing" element={<ToolPages tool="purchasing" />} />
            <Route path="/calculations" element={<ToolPages tool="calculation" />} />
            <Route path="/crm/:id" element={<CrmAccountPage />} />
            <Route path="/calendar" element={<CalendarPage mode="me" />} />
            <Route path="/calendar/team" element={<CalendarPage mode="team" />} />
            <Route path="/calendar/resources" element={<ResourcesPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/mail" element={<MailPage />} />
            <Route path="/kvp" element={<KvpPage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
            <Route path="/plugin/:id" element={<PluginPage />} />
            <Route path="*" element={<div className="page"><h1>Seite nicht gefunden</h1></div>} />
          </Routes>
        </Suspense>
      </Layout>
    </I18nProvider>
  );
}
