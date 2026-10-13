import Link from "next/link";

import { FilterTabs, NoRows, Panel, Td, TableShell, Th, Tr } from "@/components/admin/Panels";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { Badge } from "@/components/ui/Badge";
import { countAdminLogs, listAdminLogs } from "@/lib/db/admin";
import type { AdminLogTargetType } from "@/lib/db/types";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata = { title: "Audit log — Admin" };

const TARGETS: { label: string; value: AdminLogTargetType }[] = [
  { label: "Accounts", value: "user" },
  { label: "Plans", value: "plan" },
  { label: "Subscriptions", value: "subscription" },
  { label: "Gateways", value: "gateway" },
  { label: "Support", value: "support" },
];

/**
 * The administrative audit log.
 *
 * Append-only by construction: there is no edit and no delete anywhere in
 * the codebase, and a row survives the deletion of whatever it refers to —
 * the record that an account was deleted has to outlive the account.
 *
 * Credential updates are logged as events with the field names that
 * changed. The values are never written here, so this page stays safe to
 * read over somebody's shoulder.
 */
export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.target) ? params.target[0] : params.target;
  const target = TARGETS.find((entry) => entry.value === raw)?.value;

  const entries = listAdminLogs({
    ...(target ? { targetType: target } : {}),
    limit: 200,
  });
  const total = countAdminLogs();

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Administration"
        title="Audit log"
        lede={`${total} recorded action${total === 1 ? "" : "s"}. Most recent 200 shown. Entries are never edited or removed.`}
      />

      <Panel title="Everything an administrator changed">
        <FilterTabs
          current={target ?? "all"}
          options={[
            { label: "All", value: "all", href: "/admin/logs", count: total },
            ...TARGETS.map((entry) => ({
              label: entry.label,
              value: entry.value,
              href: `/admin/logs?target=${entry.value}`,
            })),
          ]}
        />

        <div className="mt-4">
          {entries.length === 0 ? (
            <NoRows>
              {target
                ? "Nothing of that kind has been changed."
                : "No administrative action has been taken yet."}
            </NoRows>
          ) : (
            <TableShell
              head={
                <>
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Detail</Th>
                  <Th>Administrator</Th>
                </>
              }
            >
              {entries.map((entry) => (
                <Tr key={entry.id}>
                  <Td mono className="whitespace-nowrap">
                    {formatDateTime(entry.createdAt)}
                  </Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <span className="t-data whitespace-nowrap text-cloud-200">
                        {entry.action}
                      </span>
                      {severe(entry.action) ? (
                        <Badge tone="fail">Sensitive</Badge>
                      ) : null}
                    </span>
                  </Td>
                  <Td>
                    {entry.targetType === "user" && entry.targetId ? (
                      <Link
                        href={`/admin/users/${entry.targetId}`}
                        className="text-azure-600 transition-colors hover:text-azure-600"
                      >
                        {entry.targetLabel ?? entry.targetId}
                      </Link>
                    ) : (
                      <span className="text-cloud-200">
                        {entry.targetLabel ?? entry.targetType}
                      </span>
                    )}
                  </Td>
                  <Td className="max-w-[26rem] text-cloud-400">
                    {entry.detail ?? "—"}
                  </Td>
                  <Td mono className="text-cloud-600">
                    {entry.adminEmail}
                  </Td>
                </Tr>
              ))}
            </TableShell>
          )}
        </div>
      </Panel>
    </div>
  );
}

/**
 * Actions worth a second glance in a list of two hundred: deletions,
 * suspensions, role grants, re-pricing and anything touching payment
 * credentials.
 */
function severe(action: string): boolean {
  return (
    action.includes("delete") ||
    action.includes("block") ||
    action.includes("role") ||
    action.includes("price") ||
    action.includes("credential")
  );
}
