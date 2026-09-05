import { useCallback, useEffect, useState } from "react";
import { Trash2, UserRound, Users } from "lucide-react";
import {
  forgetVisitor,
  listVisitors,
  type VisitorSummary,
} from "../../lib/visitorApi";
import { EmptyState, ErrorState, Panel, PanelSkeleton } from "./ui";

/**
 * Who the kiosk has stored a face for, and the means to delete them.
 *
 * This tab is not a convenience. Faces are enrolled silently — a stranger who
 * talks to the kiosk gets a reference photo written to the vision backend's
 * gallery and a transcript filed under it without being asked — so somewhere
 * a member of staff has to be able to see who is on file and remove one on
 * request. Deleting here removes the transcript, the profile AND the enrolled
 * photo, which is what makes the removal real: leaving the photo behind would
 * mean the person is still recognised, just with no history.
 *
 * Transcripts are deliberately NOT shown. Staff need to identify and delete a
 * record, which the name, dates and counts support; reading what a visitor
 * said to the kiosk is a different power and this tab does not grant it.
 */

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export default function VisitorsTab({ passcode }: { passcode: string | null }) {
  const [visitors, setVisitors] = useState<VisitorSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [confirmUid, setConfirmUid] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!passcode) {
      setError("No operator passcode — sign in again.");
      return;
    }
    setError(null);
    const list = await listVisitors(passcode);
    if (list === null) {
      setError(
        "Could not read the visitor store. It is served only to the kiosk itself, so this tab has to be open on the kiosk machine.",
      );
      return;
    }
    setVisitors(list);
  }, [passcode]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (uid: string) => {
      if (!passcode) return;
      setBusyUid(uid);
      const ok = await forgetVisitor(uid, passcode);
      setBusyUid(null);
      setConfirmUid(null);
      if (!ok) {
        setError(`Could not delete ${uid}.`);
        return;
      }
      setVisitors((prev) => prev?.filter((v) => v.uid !== uid) ?? prev);
    },
    [passcode],
  );

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!visitors) return <PanelSkeleton rows={4} />;

  return (
    <Panel
      title="Visitors"
      subtitle={`${visitors.length} recognised ${visitors.length === 1 ? "face" : "faces"} on this kiosk. Deleting removes the conversation, the profile and the stored photo.`}
      action={
        <button onClick={load} className="text-xs text-slate-500 hover:text-brand-600">
          Refresh
        </button>
      }
    >
      {visitors.length === 0 ? (
        <EmptyState
          icon={<Users className="w-8 h-8" />}
          title="No faces stored yet"
          hint="A visitor is enrolled the first time the camera sees them and cannot match them to anyone already known."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                <th className="py-2 pr-4 font-medium">Visitor</th>
                <th className="py-2 pr-4 font-medium">Known about them</th>
                <th className="py-2 pr-4 font-medium whitespace-nowrap">Visits</th>
                <th className="py-2 pr-4 font-medium whitespace-nowrap">Messages</th>
                <th className="py-2 pr-4 font-medium whitespace-nowrap">Last seen</th>
                <th className="py-2 font-medium sr-only">Delete</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visitors.map((v) => (
                <tr key={v.uid} className="align-top">
                  <td className="py-3 pr-4">
                    <div className="flex items-start gap-2">
                      <UserRound className="w-4 h-4 mt-0.5 text-slate-300 shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium text-slate-800 truncate">
                          {v.profile.displayName ?? "Unnamed visitor"}
                        </div>
                        {/* The uid is the gallery label the camera matches on,
                            so it is what staff need when looking in the faces
                            directory itself. */}
                        <div className="text-[11px] text-slate-400 font-mono truncate">
                          {v.uid}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {v.enrolled ? "Enrolled by the kiosk" : "Photo added by staff"}
                          {` · ${v.samples} photo${v.samples === 1 ? "" : "s"}`}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    {v.profile.facts.length === 0 ? (
                      <span className="text-slate-400 text-xs">Nothing recorded</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {v.profile.facts.map((f) => (
                          <li key={f.key} className="text-xs text-slate-600">
                            <span className="text-slate-400">{f.key}:</span> {f.value}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-slate-600">{v.visits}</td>
                  <td className="py-3 pr-4 tabular-nums text-slate-600">
                    {v.messageCount}
                  </td>
                  <td className="py-3 pr-4 text-xs text-slate-500 whitespace-nowrap">
                    {fmtDate(v.lastSeen)}
                  </td>
                  <td className="py-3 text-right">
                    {confirmUid === v.uid ? (
                      // Two-step, because this deletes a face and a
                      // conversation and there is no undo behind it.
                      <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                        <button
                          onClick={() => remove(v.uid)}
                          disabled={busyUid === v.uid}
                          className="text-xs px-2 py-1 rounded bg-warn-50 text-warn-700 border border-warn-200 disabled:opacity-50"
                        >
                          {busyUid === v.uid ? "Deleting…" : "Delete for good"}
                        </button>
                        <button
                          onClick={() => setConfirmUid(null)}
                          className="text-xs text-slate-500 hover:text-slate-700"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmUid(v.uid)}
                        className="p-1.5 rounded text-slate-400 hover:text-warn-700 hover:bg-warn-50"
                        aria-label={`Delete ${v.profile.displayName ?? v.uid}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
