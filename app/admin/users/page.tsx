import Link from "next/link";

import { FilterTabs, NoRows, Panel, Td, TableShell, Th, Tr } from "@/components/admin/Panels";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { Badge } from "@/components/ui/Badge";
import { countAdminUsers, listAdminUsers } from "@/lib/db/admin";
import { formatAge, formatDate } from "@/lib/format";
import { isPlanId, type PlanId } from "@/lib/plans";

export const dynamic = "force-dynamic";

export const metadata = { title: "Users — Admin" };

const PER_PAGE = 50;

/**
 * The account list.
 *
 * Search and filters are query parameters read on the server, not client
 * state: an admin who blocks somebody and comes back with the browser
 * button should land on the same filtered list they left, and a filtered
 * view should be a URL they can send to a colleague.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = single(params.q).trim();
  const statusParam = single(params.status);
  const status =
    statusParam === "active" || statusParam === "blocked" ? statusParam : undefined;
  const planParam = single(params.plan);
  const plan: PlanId | "none" | undefined =
    planParam === "none" ? "none" : isPlanId(planParam) ? planParam : undefined;
  const page = Math.max(1, Number.parseInt(single(params.page), 10) || 1);

  const users = listAdminUsers({
    ...(q ? { search: q } : {}),
    ...(status ? { status } : {}),
    ...(plan ? { plan } : {}),
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
  });

  // Counted without the plan filter, which lives on the joined
  // subscription rather than on the account, so the totals below always
  // agree with the status tabs above them.
  const total = countAdminUsers({ ...(q ? { search: q } : {}) });
  const activeCount = countAdminUsers({ ...(q ? { search: q } : {}), status: "active" });
  const blockedCount = countAdminUsers({ ...(q ? { search: q } : {}), status: "blocked" });
  const now = Date.now();

  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { q, status: status ?? "", plan: plan ?? "", ...patch };
    for (const [key, value] of Object.entries(merged)) {
      if (value) next.set(key, value);
    }
    const query = next.toString();
    return query ? `/admin/users?${query}` : "/admin/users";
  };

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Administration"
        title="Users"
        lede={`${total} account${total === 1 ? "" : "s"}${q ? ` matching “${q}”` : ""}. Select an account to change its plan, limits or status.`}
      />

      <Panel
        title="Find an account"
        description="Search matches name and email. Filters combine."
      >
        <form method="get" action="/admin/users" className="flex flex-wrap gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Name or email"
            aria-label="Search accounts"
            className="h-11 min-w-0 flex-1 rounded-xl border border-ink-700 bg-ink-900 px-3.5 text-[0.9375rem] text-cloud-50 outline-none transition-all placeholder:text-cloud-600 focus:border-azure-500/60 focus:bg-ink-900 focus:ring-4 focus:ring-azure-500/12"
          />
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {plan ? <input type="hidden" name="plan" value={plan} /> : null}
          <button
            type="submit"
            className="grad-brand h-11 rounded-xl px-5 text-[0.875rem] font-medium text-white"
          >
            Search
          </button>
          {q || status || plan ? (
            <Link
              href="/admin/users"
              className="glass inline-flex h-11 items-center rounded-xl px-4 text-[0.875rem] text-cloud-200 transition-colors hover:border-ink-700"
            >
              Clear
            </Link>
          ) : null}
        </form>

        <div className="mt-4 space-y-2">
          <FilterTabs
            current={status ?? "all"}
            options={[
              { label: "All", value: "all", href: href({ status: undefined, page: undefined }), count: total },
              { label: "Active", value: "active", href: href({ status: "active", page: undefined }), count: activeCount },
              { label: "Suspended", value: "blocked", href: href({ status: "blocked", page: undefined }), count: blockedCount },
            ]}
          />
          <FilterTabs
            current={plan ?? "any"}
            options={[
              { label: "Any plan", value: "any", href: href({ plan: undefined, page: undefined }) },
              { label: "Free", value: "free", href: href({ plan: "free", page: undefined }) },
              { label: "Basic", value: "basic", href: href({ plan: "basic", page: undefined }) },
              { label: "Pro", value: "pro", href: href({ plan: "pro", page: undefined }) },
              { label: "No subscription", value: "none", href: href({ plan: "none", page: undefined }) },
            ]}
          />
        </div>
      </Panel>

      <Panel
        title="Accounts"
        description="Scan usage is for the current billing month and resets on the renewal date."
      >
        {users.length === 0 ? (
          <NoRows>No account matches those filters.</NoRows>
        ) : (
          <TableShell
            head={
              <>
                <Th>Account</Th>
                <Th>Plan</Th>
                <Th>Scans this month</Th>
                <Th>Sites</Th>
                <Th>Reports</Th>
                <Th>Renews</Th>
                <Th>Joined</Th>
                <Th>Last seen</Th>
                <Th />
              </>
            }
          >
            {users.map((user) => (
              <Tr key={user.id}>
                <Td>
                  <Link
                    href={`/admin/users/${user.id}`}
                    className="block min-w-0 transition-colors hover:text-cloud-50"
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium text-cloud-50">
                        {user.name}
                      </span>
                      {user.role === "admin" ? (
                        <Badge tone="brand">Admin</Badge>
                      ) : null}
                      {user.status !== "active" ? (
                        <Badge tone="fail" dot>
                          Suspended
                        </Badge>
                      ) : null}
                    </span>
                    <span className="t-data mt-0.5 block truncate text-[0.75rem] text-cloud-600">
                      {user.email}
                    </span>
                  </Link>
                </Td>

                <Td>
                  {user.planId ? (
                    <span className="flex flex-col gap-1">
                      <span className="text-cloud-200">{user.planName}</span>
                      {user.paymentStatus && user.paymentStatus !== "free" ? (
                        <span className="t-data text-[0.75rem] text-cloud-600">
                          {user.paymentStatus}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-cloud-600">None</span>
                  )}
                </Td>

                <Td mono>
                  {user.scanLimit === null ? (
                    "—"
                  ) : (
                    <span
                      className={
                        user.scansUsed >= user.scanLimit
                          ? "text-amber-400"
                          : "text-cloud-200"
                      }
                    >
                      {user.scansUsed} / {user.scanLimit}
                    </span>
                  )}
                </Td>

                <Td mono>
                  {user.websites}
                  {user.siteLimit !== null ? (
                    <span className="text-cloud-600"> / {user.siteLimit}</span>
                  ) : null}
                </Td>

                <Td mono>{user.reports}</Td>

                <Td mono>
                  {user.cycleEnd ? formatDate(user.cycleEnd) : "—"}
                </Td>

                <Td mono>{formatDate(user.createdAt)}</Td>

                <Td mono>
                  {user.lastActiveAt ? formatAge(user.lastActiveAt, now) : "Never"}
                </Td>

                <Td>
                  <Link
                    href={`/admin/users/${user.id}`}
                    className="text-[0.8125rem] whitespace-nowrap text-azure-600 transition-colors hover:text-azure-600"
                  >
                    Manage →
                  </Link>
                </Td>
              </Tr>
            ))}
          </TableShell>
        )}

        {(page > 1 || users.length === PER_PAGE) ? (
          <div className="mt-4 flex items-center justify-between border-t border-ink-700 pt-4">
            {page > 1 ? (
              <Link
                href={href({ page: page === 2 ? undefined : String(page - 1) })}
                className="text-[0.8125rem] text-azure-600 hover:text-azure-600"
              >
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="t-data text-[0.75rem] text-cloud-600">
              Page {page}
            </span>
            {users.length === PER_PAGE ? (
              <Link
                href={href({ page: String(page + 1) })}
                className="text-[0.8125rem] text-azure-600 hover:text-azure-600"
              >
                Next →
              </Link>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function single(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
