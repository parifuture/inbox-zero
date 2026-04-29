import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import { HistoricalCleanup } from "./HistoricalCleanup";

export default async function HistoricalCleanupPage() {
  return (
    <>
      <PermissionsCheck />
      <HistoricalCleanup />
    </>
  );
}
