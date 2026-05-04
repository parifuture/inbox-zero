import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import { Decisions } from "@/app/(app)/[emailAccountId]/decisions/Decisions";

export default function DecisionsPage() {
  return (
    <>
      <PermissionsCheck />
      <Decisions />
    </>
  );
}
