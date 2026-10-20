import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, EmptyState, Spinner, ThemeProvider } from '@d3cloud/ui';
import { Shell } from './components/Shell';
import { EntryHeading, EntryShell } from './entry/EntryShell';
import { fetchSession, logout, type SessionState } from './lib/api';
import { routeFor, useLocation } from './lib/router';
import { SessionProvider } from './lib/session';
import { Login } from './screens/Login';
import { PhaseDetail } from './screens/PhaseDetail';
import { Phases } from './screens/Phases';
import { Dashboard } from './screens/Dashboard';
import { Projects } from './screens/Projects';
import { Tokens } from './screens/Tokens';
import { ProjectOverview } from './screens/ProjectOverview';
import { Activity } from './screens/Activity';
import { Adrs } from './screens/Adrs';
import { AuditIndex } from './screens/AuditIndex';
import { DocumentEditor } from './screens/DocumentEditor';
import { Documents } from './screens/Documents';
import { DriftView } from './screens/DriftView';
import { FindingDetail } from './screens/FindingDetail';
import { Findings } from './screens/Findings';
import { Glossary } from './screens/Glossary';
import { Ideas } from './screens/Ideas';
import { Guidelines } from './screens/Guidelines';
import { ProjectIdeas } from './screens/ProjectIdeas';
import { ProjectIdeaDetail } from './screens/ProjectIdeaDetail';
import { Members } from './screens/Members';
import { AcceptInvite } from './screens/AcceptInvite';
import { Health } from './screens/Health';
import { RequirementDetail } from './screens/RequirementDetail';
import { RiskRegister } from './screens/RiskRegister';
import { Search as SearchScreen } from './screens/Search';
import { Requirements } from './screens/Requirements';
import { RegisterView } from './screens/RegisterView';
import { ScopeOfWorkView } from './screens/ScopeOfWorkView';
import { ScreenDetail } from './screens/ScreenDetail';
import { Screens } from './screens/Screens';
import { TaskDetail } from './screens/TaskDetail';

/**
 * The console shell.
 *
 * One question decides what renders: is there a session? The answer comes from the server, not from
 * anything held in the browser — there is no token in `localStorage` to go stale or be stolen.
 */

type State =
  | { status: 'loading' }
  | { status: 'anonymous'; oidcAvailable: boolean }
  | { status: 'signed-in'; session: SessionState }
  | { status: 'unreachable' };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const { path, search } = useLocation();

  const load = useCallback(() => {
    void fetchSession()
      .then((session) => {
        setState(
          session.authenticated
            ? { status: 'signed-in', session }
            : { status: 'anonymous', oidcAvailable: session.oidcAvailable },
        );
      })
      .catch(() => {
        setState({ status: 'unreachable' });
      });
  }, []);

  useEffect(load, [load]);

  // FRM-T-13.2: both states come before a session is known, so they stand in the entry shell with
  // Sign in rather than on a bare page.
  if (state.status === 'loading') {
    return (
      <ThemeProvider>
        <EntryShell>
          <EntryHeading title="Foreman" />
          <Spinner label="Loading Foreman" />
        </EntryShell>
      </ThemeProvider>
    );
  }

  if (state.status === 'unreachable') {
    return (
      <ThemeProvider>
        <EntryShell>
          <EntryHeading title="Foreman is not answering" focusOnMount />
          {/* Said plainly: the person reading this is the person who can fix it. */}
          <Alert
            tone="danger"
            title="Could not reach the server"
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setState({ status: 'loading' });
                  load();
                }}
              >
                Try again
              </Button>
            }
          >
            The API did not respond. Check the server, then try again.
          </Alert>
        </EntryShell>
      </ThemeProvider>
    );
  }

  // Before the login branch: somebody accepting an invitation has no account yet, which is the
  // entire point of the link they followed.
  if (path === '/accept' || path === '/invite') {
    return (
      <ThemeProvider>
        <AcceptInvite />
      </ThemeProvider>
    );
  }

  if (state.status === 'anonymous') {
    return (
      <ThemeProvider>
        <Login oidcAvailable={state.oidcAvailable} onSignedIn={load} />
      </ThemeProvider>
    );
  }

  const { user } = state.session;
  const board = state.session.mode === 'board';

  return (
    <ThemeProvider>
      <SessionProvider session={state.session}>
        <Shell
          path={path}
          user={user}
          nav={{ board, admin: user.role === 'admin' }}
          onSignOut={() => {
            void logout().finally(load);
          }}
        >
          <Screen path={path} search={search} />
        </Shell>
      </SessionProvider>
    </ThemeProvider>
  );
}

/** One screen, chosen by the path. The query configures it. */
function Screen({ path, search }: { path: string; search: string }) {
  const route = routeFor(path);

  switch (route.screen) {
    case 'dashboard':
      return <Dashboard />;
    case 'projects':
      return <Projects />;
    case 'project-ideas':
      return <ProjectIdeas />;
    case 'project-idea':
      // Keyed by the ID so moving from one idea to a related one resets every section's editing
      // state, instead of carrying half an edit from the last idea into the next.
      return <ProjectIdeaDetail key={route.humanId} humanId={route.humanId ?? ''} />;
    case 'guidelines':
      return <Guidelines />;
    case 'members':
      return <Members />;
    case 'project':
      return <ProjectOverview code={route.code ?? ''} />;
    case 'phases':
      return <Phases code={route.code ?? ''} />;
    case 'phase':
      return <PhaseDetail code={route.code ?? ''} phaseHumanId={route.humanId ?? ''} />;
    case 'requirements':
      // Keyed by the query, so following `?uncovered=true` from a screen already showing this
      // table re-reads the filters instead of quietly ignoring them.
      return <Requirements key={search} code={route.code ?? ''} search={search} />;
    case 'requirement':
      return <RequirementDetail humanId={route.humanId ?? ''} />;
    case 'scope-of-work':
      return <ScopeOfWorkView code={route.code ?? ''} />;
    case 'register':
      return <RegisterView code={route.code ?? ''} />;
    case 'documents':
      return <Documents code={route.code ?? ''} />;
    case 'document':
      return <DocumentEditor code={route.code ?? ''} id={route.humanId ?? ''} />;
    case 'adrs':
      return <Adrs code={route.code ?? ''} />;
    case 'risks':
      return <RiskRegister code={route.code ?? ''} />;
    case 'glossary':
      return <Glossary code={route.code ?? ''} />;
    case 'ideas':
      return <Ideas code={route.code ?? ''} />;
    case 'audits':
      return <AuditIndex code={route.code ?? ''} />;
    case 'activity':
      return <Activity code={route.code ?? ''} />;
    case 'findings':
      return <Findings key={search} search={search} />;
    case 'finding':
      return <FindingDetail humanId={route.humanId ?? ''} />;
    case 'drift':
      return <DriftView code={route.code ?? ''} />;
    case 'screens':
      return <Screens code={route.code ?? ''} />;
    case 'screen':
      // Keyed by the ID, so moving to another screen resets its viewport, theme and forms.
      return <ScreenDetail key={route.humanId} code={route.code ?? ''} humanId={route.humanId ?? ''} />;
    case 'health':
      return <Health />;
    case 'tokens':
      return <Tokens />;
    case 'search':
      return <SearchScreen key={search} search={search} />;
    case 'task':
      return <TaskDetail humanId={route.humanId ?? ''} />;
    case 'not-found':
      return (
        <EmptyState kind="no-results" heading="That page does not exist">
          Nothing is served at {path}.
        </EmptyState>
      );
  }
}
