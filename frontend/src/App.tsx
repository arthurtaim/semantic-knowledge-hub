import { useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import type { SessionResponse } from "./api/types";
import { Layout } from "./components/Layout";
import { canAsk } from "./lib/aiMode";
import { documentTitle } from "./lib/routes";
import { SessionContext } from "./lib/session";
import { AskPage } from "./pages/AskPage";
import { CorporatePage } from "./pages/CorporatePage";
import { DocumentCreatePage } from "./pages/DocumentCreatePage";
import { DocumentPage } from "./pages/DocumentPage";
import { ExplorerPage } from "./pages/ExplorerPage";
import { GraphPage } from "./pages/GraphPage";
import { HomePage } from "./pages/HomePage";
import { ImportPage } from "./pages/ImportPage";
import { KnowledgeOnboardingPage } from "./pages/KnowledgeOnboardingPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProjectPage } from "./pages/ProjectPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProposalDetailPage } from "./pages/ProposalDetailPage";
import { ProposalEditorPage } from "./pages/ProposalEditorPage";
import { ProposalsPage } from "./pages/ProposalsPage";
import { PublicationJobPage } from "./pages/PublicationJobPage";
import { PublicationsPage } from "./pages/PublicationsPage";
import { TaskPage } from "./pages/TaskPage";
import { TemplateDetailPage } from "./pages/TemplateDetailPage";
import { TemplateEditorPage } from "./pages/TemplateEditorPage";
import { TemplatesPage } from "./pages/TemplatesPage";

/** The browser tab names the page as the toolbar does (lib/routes.ts). */
function useDocumentTitle(askAvailable: boolean) {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = documentTitle(pathname, askAvailable);
  }, [pathname, askAvailable]);
}

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  useDocumentTitle(canAsk(session?.features.ai_mode));

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null));
  }, []);

  return (
    <SessionContext.Provider value={session}>
      <Layout>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/documents" element={<ExplorerPage />} />
          <Route path="/documents/new" element={<DocumentCreatePage />} />
          <Route path="/documents/import" element={<ImportPage />} />
          <Route path="/documents/onboarding" element={<KnowledgeOnboardingPage />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/templates/new" element={<TemplateEditorPage />} />
          <Route path="/templates/:id" element={<TemplateDetailPage />} />
          <Route path="/templates/:id/edit" element={<TemplateEditorPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:key" element={<ProjectPage />} />
          <Route path="/tasks/:key" element={<TaskPage />} />
          <Route path="/proposals" element={<ProposalsPage />} />
          <Route path="/proposals/new" element={<ProposalEditorPage />} />
          <Route path="/proposals/:id" element={<ProposalDetailPage />} />
          <Route path="/publications" element={<PublicationsPage />} />
          <Route path="/publications/:jobId" element={<PublicationJobPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/corporate/:id" element={<CorporatePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Layout>
    </SessionContext.Provider>
  );
}
