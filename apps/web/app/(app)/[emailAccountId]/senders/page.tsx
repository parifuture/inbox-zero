import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import { SendersPage } from "@/app/(app)/[emailAccountId]/senders/SendersPage";

export default function Page() {
  return (
    <>
      <PermissionsCheck />
      <SendersPage />
    </>
  );
}
