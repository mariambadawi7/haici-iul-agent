import { MessageSquarePlus, Trash2, BookOpen } from "lucide-react";
import type { Session } from "../types";

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

export default function Sidebar({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  return (
    <aside className="w-72 shrink-0 panel border-r flex flex-col">
      <div className="p-4">
        <button onClick={onCreate} className="btn-primary w-full">
          <MessageSquarePlus className="w-4 h-4" />
          New conversation
        </button>
      </div>
      <div className="px-4">
        <div className="badge-serif">Conversations</div>
        <div className="mt-2 divider-gold opacity-60" />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
        {sessions.length === 0 ? (
          <div className="text-sm text-ink-500 px-3 py-6 text-center font-serif italic">
            No conversations yet
          </div>
        ) : (
          sessions.map((s) => {
            const active = s.id === activeId;
            return (
              <div
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={`group flex items-start gap-3 px-3 py-2.5 rounded-md cursor-pointer transition border ${
                  active
                    ? "bg-accent/10 border-accent/40 text-ink-100"
                    : "border-transparent hover:bg-white/5 hover:border-bg-border text-ink-300"
                }`}
              >
                <BookOpen
                  className={`w-4 h-4 mt-0.5 shrink-0 ${
                    active ? "text-accent" : "opacity-60"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate font-medium">
                    {s.title || "Untitled"}
                  </div>
                  <div className="text-[10px] text-ink-500 mt-0.5 tracking-wide">
                    {s.messages.length} msg ·{" "}
                    {new Date(s.updatedAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition p-1 rounded text-ink-500 hover:text-red-300 hover:bg-red-500/10"
                  aria-label="Delete conversation"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
      <div className="divider-gold opacity-60" />
      <div className="p-4 text-[10px] text-ink-500 leading-relaxed">
        <div className="font-serif italic text-ink-300 mb-1">Privacy notice</div>
        Conversations are stored locally in this browser only.
      </div>
    </aside>
  );
}
