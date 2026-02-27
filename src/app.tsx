import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import { Button, Badge, InputArea, Empty } from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import { Switch } from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  MoonIcon,
  SunIcon,
  BrainIcon,
  CaretDownIcon,
  CircleIcon,
  StarIcon,
  CodeIcon,
  CopyIcon,
  PencilSimpleIcon,
  CheckIcon,
  PlusIcon,
  ChatIcon,
  ListIcon,
  XIcon
} from "@phosphor-icons/react";

// ── Types ─────────────────────────────────────────────────────────────

type Session = {
  id: string;
  title: string;
  createdAt: string;
};

// ── Session management ─────────────────────────────────────────────────

const SESSIONS_KEY = "code-review-sessions";

function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions: Session[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    console.warn(
      "Failed to persist sessions (localStorage unavailable or full)"
    );
  }
}

function newSession(): Session {
  return {
    id: crypto.randomUUID(),
    title: "New Chat",
    createdAt: new Date().toISOString()
  };
}

// ── Theme toggle ──────────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);
  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Starter prompts ───────────────────────────────────────────────────

const STARTER_PROMPTS = [
  "Show my review history and stats",
  "What recurring anti-patterns have you noticed in my code?",
  "Review this for typos and vulnerabilities:\n```js\napp.get('/user', (req, res) => {\n  const id = req.query.id;\n  const passwrod = req.body.passwrod;\n  db.query(`SELECT * FROM users WHERE id = ${id}`, (err, r) => res.json(r[0]));\n});\n```",
  "Full prod-level review:\n```ts\nasync function fetchUser(id: string) {\n  const res = await fetch(`/api/users/${id}`);\n  const data = await res.json();\n  return data.user.name;\n}\n```"
];

// ── Sidebar ───────────────────────────────────────────────────────────

interface SidebarProps {
  sessions: Session[];
  activeId: string;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

function Sidebar({
  sessions,
  activeId,
  collapsed,
  onToggle,
  onSelect,
  onCreate,
  onDelete
}: SidebarProps) {
  const grouped = groupByDate(sessions);

  return (
    <div
      className="flex flex-col h-screen shrink-0 transition-all duration-200 border-r border-kumo-line bg-kumo-base"
      style={{ width: collapsed ? 52 : 240 }}
    >
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-kumo-line">
        <button
          type="button"
          onClick={onToggle}
          className="p-1.5 rounded-lg text-kumo-inactive hover:text-kumo-default hover:bg-kumo-elevated transition-colors"
          aria-label="Toggle sidebar"
        >
          <ListIcon size={16} />
        </button>
        {!collapsed && (
          <button
            type="button"
            onClick={onCreate}
            className="flex items-center gap-1.5 flex-1 px-2 py-1.5 rounded-lg text-xs font-medium bg-kumo-brand text-white hover:opacity-90 transition-opacity"
          >
            <PlusIcon size={13} />
            New Chat
          </button>
        )}
      </div>

      {/* Session list */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto py-2">
          {sessions.length === 0 && (
            <p className="text-xs text-kumo-inactive text-center px-4 py-6">
              No chats yet. Start one!
            </p>
          )}
          {grouped.map(({ label, items }) => (
            <div key={label}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-kumo-inactive px-3 py-1.5">
                {label}
              </p>
              {items.map((session) => (
                <div key={session.id} className="group relative mx-2">
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    className={`flex w-full items-center gap-2 px-2 py-2 rounded-lg transition-colors ${
                      session.id === activeId
                        ? "bg-kumo-elevated text-kumo-default"
                        : "text-kumo-subtle hover:bg-kumo-elevated/60 hover:text-kumo-default"
                    }`}
                  >
                    <ChatIcon size={13} className="shrink-0 opacity-60" />
                    <span className="flex-1 text-xs truncate pr-4">
                      {session.title}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete chat"
                    onClick={() => onDelete(session.id)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:text-kumo-danger transition-all"
                  >
                    <XIcon size={12} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Collapsed: new chat icon */}
      {collapsed && (
        <div className="flex-1 flex flex-col items-center pt-3 gap-2">
          <button
            type="button"
            onClick={onCreate}
            className="p-1.5 rounded-lg text-kumo-inactive hover:text-kumo-default hover:bg-kumo-elevated transition-colors"
            aria-label="New chat"
          >
            <PlusIcon size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function groupByDate(sessions: Session[]) {
  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString();
  const groups: Record<string, Session[]> = {};

  for (const s of sessions) {
    const d = new Date(s.createdAt).toDateString();
    const label =
      d === today
        ? "Today"
        : d === yesterday
          ? "Yesterday"
          : new Date(s.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric"
            });
    if (!groups[label]) groups[label] = [];
    groups[label].push(s);
  }

  return Object.entries(groups).map(([label, items]) => ({ label, items }));
}

// ── Chat ──────────────────────────────────────────────────────────────

interface ChatProps {
  sessionId: string;
  onFirstMessage: (title: string) => void;
}

function Chat({ sessionId, onFirstMessage }: ChatProps) {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleUpdated = useRef(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<string | null>(null);

  const agent = useAgent({
    agent: "CodeReviewAgent",
    name: sessionId, // each session = its own DO instance
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, clearHistory, stop, status, setMessages } =
    useAgentChat({ agent });

  const isStreaming = status === "streaming" || status === "submitted";

  // Auto-title from first user message
  useEffect(() => {
    if (titleUpdated.current || messages.length === 0) return;
    const first = messages.find((m) => m.role === "user");
    if (!first) return;
    const part = first.parts.find((p) => p.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    if (!part?.text) return;
    const titleText = part.text.split("\n")[0].trim().slice(0, 45);
    if (!titleText) return;
    titleUpdated.current = true;
    onFirstMessage(titleText);
  }, [messages, onFirstMessage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) textareaRef.current.focus();
  }, [isStreaming]);

  const handleCopy = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  const startEdit = useCallback((id: string, text: string) => {
    setEditingId(id);
    setEditingText(text);
  }, []);

  const saveEdit = useCallback(
    (id: string) => {
      const msgIndex = messages.findIndex((m) => m.id === id);
      const text = editingText;
      setEditingId(null);
      if (msgIndex !== -1) {
        setMessages(messages.slice(0, msgIndex));
        setPendingEdit(text);
      } else {
        sendMessage({ role: "user", parts: [{ type: "text", text }] });
      }
    },
    [editingText, sendMessage, setMessages, messages]
  );

  useEffect(() => {
    if (pendingEdit !== null) {
      setPendingEdit(null);
      sendMessage({
        role: "user",
        parts: [{ type: "text", text: pendingEdit }]
      });
    }
  }, [pendingEdit, sendMessage]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingText("");
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex flex-col flex-1 h-screen bg-kumo-elevated min-w-0">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line shrink-0">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default flex items-center gap-2">
              <CodeIcon
                size={20}
                weight="duotone"
                className="text-kumo-brand"
              />
              Code Review AI
            </h1>
            <Badge variant="secondary">
              <StarIcon
                size={11}
                weight="fill"
                className="mr-1 text-yellow-400"
              />
              Llama 3.3 · 70B
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <span className="text-xs text-kumo-inactive">
                {connected ? "Connected" : "Disconnected"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-kumo-inactive">Debug</span>
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<CodeIcon size={32} weight="duotone" />}
              title="Paste code for review"
              contents={
                <div className="space-y-3">
                  <p className="text-sm text-kumo-inactive text-center max-w-sm mx-auto">
                    I'll review bugs, security, performance and style — and
                    remember your patterns across sessions.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {STARTER_PROMPTS.map((prompt) => {
                      const label = prompt.split("\n")[0].slice(0, 50);
                      return (
                        <Button
                          key={label}
                          variant="outline"
                          size="sm"
                          disabled={isStreaming}
                          onClick={() =>
                            sendMessage({
                              role: "user",
                              parts: [{ type: "text", text: prompt }]
                            })
                          }
                        >
                          {label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}

                {/* Reasoning parts */}
                {message.parts
                  .filter(
                    (part) =>
                      part.type === "reasoning" &&
                      (part as { text?: string }).text?.trim()
                  )
                  .map((part, i) => {
                    const reasoning = part as {
                      type: "reasoning";
                      text: string;
                      state?: "streaming" | "done";
                    };
                    const isDone = reasoning.state === "done" || !isStreaming;
                    return (
                      <div key={i} className="flex justify-start">
                        <details className="max-w-[85%] w-full" open={!isDone}>
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                            <BrainIcon size={14} className="text-purple-400" />
                            <span className="font-medium text-kumo-default">
                              Reasoning
                            </span>
                            {isDone ? (
                              <span className="text-xs text-kumo-success">
                                Complete
                              </span>
                            ) : (
                              <span className="text-xs text-kumo-brand">
                                Thinking...
                              </span>
                            )}
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-kumo-inactive"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                            {reasoning.text}
                          </pre>
                        </details>
                      </div>
                    );
                  })}

                {/* Text parts */}
                {message.parts
                  .filter((part) => part.type === "text")
                  .map((part, i) => {
                    const text = (part as { type: "text"; text: string }).text;
                    if (!text) return null;

                    if (isUser) {
                      const displayText = text;
                      const isEditing = editingId === message.id;

                      if (isEditing) {
                        return (
                          <div key={i} className="flex justify-end">
                            <div className="max-w-[85%] w-full space-y-2">
                              <textarea
                                value={editingText}
                                onChange={(e) => setEditingText(e.target.value)}
                                className="w-full px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed font-mono text-sm whitespace-pre-wrap resize-none min-h-[60px] focus:outline-none focus:ring-2 focus:ring-kumo-ring"
                                rows={Math.max(
                                  2,
                                  editingText.split("\n").length
                                )}
                              />
                              <div className="flex justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={cancelEdit}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  variant="primary"
                                  onClick={() => saveEdit(message.id)}
                                >
                                  Save
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={i} className="flex justify-end">
                          <div className="group relative max-w-[85%]">
                            <div className="absolute -left-16 top-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                type="button"
                                aria-label="Copy message"
                                onClick={() =>
                                  handleCopy(
                                    displayText,
                                    `${message.id}-${i}-copy`
                                  )
                                }
                                className="p-1.5 rounded-lg bg-kumo-base border border-kumo-line text-kumo-subtle hover:text-kumo-default transition-colors"
                              >
                                {copiedId === `${message.id}-${i}-copy` ? (
                                  <CheckIcon
                                    size={14}
                                    className="text-kumo-success"
                                  />
                                ) : (
                                  <CopyIcon size={14} />
                                )}
                              </button>
                              <button
                                type="button"
                                aria-label="Edit message"
                                onClick={() =>
                                  startEdit(message.id, displayText)
                                }
                                className="p-1.5 rounded-lg bg-kumo-base border border-kumo-line text-kumo-subtle hover:text-kumo-default transition-colors"
                              >
                                <PencilSimpleIcon size={14} />
                              </button>
                            </div>
                            <div className="px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed font-mono text-sm whitespace-pre-wrap">
                              {displayText}
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={i} className="flex justify-start">
                        <div className="group relative max-w-[85%]">
                          <div className="absolute -right-8 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              aria-label="Copy message"
                              onClick={() =>
                                handleCopy(text, `${message.id}-${i}-copy`)
                              }
                              className="p-1.5 rounded-lg bg-kumo-base border border-kumo-line text-kumo-subtle hover:text-kumo-default transition-colors"
                            >
                              {copiedId === `${message.id}-${i}-copy` ? (
                                <CheckIcon
                                  size={14}
                                  className="text-kumo-success"
                                />
                              ) : (
                                <CopyIcon size={14} />
                              )}
                            </button>
                          </div>
                          <div className="rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                            <Streamdown
                              className="sd-theme rounded-2xl rounded-bl-md p-3"
                              controls={false}
                              isAnimating={isLastAssistant && isStreaming}
                            >
                              {text}
                            </Streamdown>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder="Paste code to review, or ask about your history... (Shift+Enter for newline)"
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none resize-none max-h-64 font-mono text-sm"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
          <p className="text-[11px] text-kumo-inactive mt-1.5 text-center">
            Powered by Llama 3.3 70B · Memory persists across sessions
          </p>
        </form>
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────

function Root() {
  const [sessions, setSessions] = useState<Session[]>(() => {
    const stored = loadSessions();
    if (stored.length === 0) {
      const first = newSession();
      saveSessions([first]);
      return [first];
    }
    return stored;
  });

  const [activeId, setActiveId] = useState<string>(sessions[0].id);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleCreate = useCallback(() => {
    const session = newSession();
    setSessions((prev) => {
      const updated = [session, ...prev];
      saveSessions(updated);
      return updated;
    });
    setActiveId(session.id);
  }, []);

  const handleSelect = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const updated = prev.filter((s) => s.id !== id);
        if (updated.length === 0) {
          const fresh = newSession();
          saveSessions([fresh]);
          setActiveId(fresh.id);
          return [fresh];
        }
        saveSessions(updated);
        if (id === activeId) setActiveId(updated[0].id);
        return updated;
      });
    },
    [activeId]
  );

  const handleFirstMessage = useCallback(
    (title: string) => {
      setSessions((prev) => {
        const updated = prev.map((s) =>
          s.id === activeId ? { ...s, title } : s
        );
        saveSessions(updated);
        return updated;
      });
    },
    [activeId]
  );

  return (
    <div className="flex h-screen overflow-hidden bg-kumo-elevated">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onDelete={handleDelete}
      />
      <Chat
        key={activeId}
        sessionId={activeId}
        onFirstMessage={handleFirstMessage}
      />
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Root />
    </Suspense>
  );
}
