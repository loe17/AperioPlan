import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
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
const CrmAccountPage = lazy(() => import('./pages/CrmAccount'));
const ProjectPage = lazy(() => import('./pages/Project'));
const TeamPage = lazy(() => import('./pages/Team'));
const InboxPage = lazy(() => import('./pages/Inbox'));
const NotesPage = lazy(() => import('./pages/Notes'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const CadPage = lazy(() => import('./pages/Cad'));
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
            <Route path="/time" element={<TimePage />} />
            <Route path="/absences" element={<AbsencesPage />} />
            <Route path="/crm" element={<CrmPage />} />
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
