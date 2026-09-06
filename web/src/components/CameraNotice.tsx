/**
 * "This camera is looking at you" — the notice the person standing at the
 * kiosk gets, and the one control they have over it.
 *
 * Enrollment is silent and automatic: a face the camera cannot match is
 * cropped to `faces/<uid>/` and the conversation is filed against it, without
 * anyone being asked. The two safeguards that make that defensible — the
 * Visitors tab and the content-fenced answer cache — are both things STAFF
 * reach. This is the one that faces the visitor.
 *
 * It sits beside "Not you?" in the header and answers a different question.
 * "Not you?" means the kiosk has the WRONG person; this means the kiosk should
 * not be identifying anyone. Confusing the two costs a visitor their
 * conversation, so the wording of each says which is which.
 *
 * Rendered ONLY while the camera is genuinely streaming (`vision.publishing`),
 * never merely because the tenant configured one. A badge claiming the camera
 * is on when it failed to start would be a lie in the direction that matters,
 * and it would contradict the failure banner sitting directly below it.
 */

import { useEffect, useRef, useState } from "react";
import { Camera, EyeOff } from "lucide-react";
import type { UndoStatus } from "../hooks/useVisitor";

interface Props {
  /** True once the kiosk is deliberately not identifying anyone. */
  refused: boolean;
  /** What became of the stored face, so the receipt below can say so. */
  undoStatus: UndoStatus;
  onRefuse: () => void;
}

/**
 * The second line of the receipt. Deletion is best-effort — the sidecar can be
 * down — and it does not apply to a face the kiosk did not just enroll, so
 * this reports the outcome instead of asserting the good one.
 */
const UNDO_LINE: Record<UndoStatus, string | null> = {
  none: null,
  pending: "Deleting the photo this kiosk took of you…",
  removed: "The photo this kiosk took of you has been deleted.",
  failed:
    "The photo this kiosk took could not be deleted automatically. Ask a member of staff to remove it.",
  kept: "A photo from an earlier visit is still stored. Ask a member of staff to remove it.",
};

export default function CameraNotice({ refused, undoStatus, onRefuse }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // A kiosk is walked away from, not closed. Anything that opens has to be
  // able to close itself without the next person finding it still open.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-2 px-3 h-10 rounded-full border border-neutral-200/80 bg-surface shadow-sm text-xs text-neutral-600 hover:text-brand-700 hover:border-brand-200 transition-colors"
        title="How this kiosk uses the camera"
      >
        {refused ? (
          <EyeOff className="w-4 h-4 shrink-0 text-neutral-400" />
        ) : (
          <>
            {/* The live dot, not the word, is what reads at a glance from a
                metre away — and it is the same resting/active idiom as the
                avatar's status card, so it is not a new vocabulary to learn.
                It goes when recognition does: a badge that keeps pulsing after
                someone opts out reads as a refusal that did not take. */}
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-500" />
            </span>
            <Camera className="w-4 h-4 shrink-0" />
          </>
        )}
        <span className="hidden sm:inline">
          {refused ? "Not recognising" : "Camera on"}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="How this kiosk uses the camera"
          className="absolute right-0 top-12 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-neutral-200 bg-surface shadow-lg p-4 text-left"
        >
          {refused ? (
            <>
              <h3 className="text-sm font-semibold text-neutral-800">
                Not identifying you
              </h3>
              {/* Says only what is true. The camera is still streaming — it
                  drives the assistant's expression — and claiming otherwise
                  while the lens is live would be the same failure this whole
                  component exists to fix. */}
              <p className="mt-2 text-xs leading-relaxed text-neutral-600">
                This conversation is not linked to your face, and nothing from
                it is being stored against you.
              </p>
              {UNDO_LINE[undoStatus] && (
                <p
                  className={`mt-2 text-xs leading-relaxed ${
                    undoStatus === "failed" || undoStatus === "kept"
                      ? "text-warn-700"
                      : "text-neutral-600"
                  }`}
                >
                  {UNDO_LINE[undoStatus]}
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-neutral-600">
                The camera is still on — it is what gives the assistant its
                expressions — but it is no longer being used to identify you.
              </p>
            </>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-neutral-800">
                The camera is on
              </h3>
              {/* Says what actually happens, in the order a person cares
                  about: that they are being recognised, that something is
                  kept, and what to do about it. No client name — this text is
                  as tenant-neutral as the health banner beside it. */}
              <p className="mt-2 text-xs leading-relaxed text-neutral-600">
                This kiosk recognises faces so it can greet returning visitors
                and pick up the conversation where they left off. A photo and
                the conversation are stored against that face.
              </p>
              <button
                type="button"
                onClick={() => {
                  onRefuse();
                  // Left OPEN on purpose. The panel becomes the receipt: the
                  // person who just pressed this needs to see that something
                  // happened, and a popover that vanishes on tap looks
                  // identical to one that did nothing.
                }}
                className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-neutral-200 bg-surface text-xs font-medium text-neutral-700 hover:text-warn-700 hover:border-warn-200 transition-colors"
              >
                <EyeOff className="w-4 h-4 shrink-0" />
                Don&apos;t recognise me
              </button>
              <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
                Stops recognition for this conversation, and deletes the photo
                if this kiosk took one today. For anything stored on an earlier
                visit, ask a member of staff.
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
                If it has greeted you as someone else, use{" "}
                <span className="font-medium text-neutral-600">Not you?</span>{" "}
                instead.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
