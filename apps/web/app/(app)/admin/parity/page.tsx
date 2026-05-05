import { auth } from "@/utils/auth";
import { ErrorPage } from "@/components/ErrorPage";
import { isAdmin } from "@/utils/admin";
import { PageWrapper } from "@/components/PageWrapper";
import { PageHeader } from "@/components/PageHeader";
import { ParityDashboard } from "./ParityDashboard";

// EL-376 — parity dashboard. Surfaces EL-363 shadow-mode diff output so
// Chotu can decide when the fork pipeline has reached the ≥99% agreement
// threshold that gates sidecar sunset.
//
// Admin-gated; read-mostly. The only write path is "Prefer fork/sidecar"
// which creates a SenderDecision via POST /api/admin/parity/override and is
// audited with the parity row id.
export default async function ParityAdminPage() {
  const session = await auth();

  if (!isAdmin({ email: session?.user.email })) {
    return (
      <ErrorPage
        title="No Access"
        description="You do not have permission to access this page."
      />
    );
  }

  return (
    <PageWrapper>
      <PageHeader
        title="Parity Dashboard"
        description="Shadow-mode diff between the forked pipeline and the sidecar pipeline. Use this to track when the fork reaches the ≥99% agreement threshold that gates sidecar sunset."
      />
      <div className="mt-6 mb-20">
        <ParityDashboard />
      </div>
    </PageWrapper>
  );
}
