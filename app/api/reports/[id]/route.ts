import { optionalUser } from "@/lib/auth/guard";
import {
  deleteReportForUser,
  findReportForUser,
  listIssues,
} from "@/lib/db/audits";
import { jsonError, jsonOk } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const user = await optionalUser();
  if (!user) return jsonError("UNAUTHENTICATED", "Log in to view reports.");

  const { id } = await params;
  const report = findReportForUser(id, user.id);
  if (!report) return jsonError("NOT_FOUND", "That report does not exist.");

  return jsonOk({
    report,
    issues: report.state === "complete" ? listIssues(report.id) : [],
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const user = await optionalUser();
  if (!user) return jsonError("UNAUTHENTICATED", "Log in to delete reports.");

  const { id } = await params;
  // Ownership is part of the WHERE clause, so this cannot delete
  // someone else's report even if the id is guessed.
  if (!deleteReportForUser(id, user.id)) {
    return jsonError("NOT_FOUND", "That report does not exist.");
  }

  return jsonOk({ deleted: id });
}
