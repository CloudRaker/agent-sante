// What the agents do during a turn: our checks, the routing, the agent work, the Run tool rows.
// One group: a header with the marks of the steps, a count and the time, that opens to one row
// per step (mark, label, duration, state). Live: open under the typing bubble, the running label
// shimmers and new rows glide in. After the reply: folded under the answer.
// Own component on Arc tokens and motion presets: the Arc items for agent steps are Pro (ARC.md).
import {
  ArrowRightLeft,
  FileText,
  Hourglass,
  CalendarSearch,
  Languages,
  MapPin,
  MapPinned,
  MessageCircleQuestionMark,
  Reply,
  LockKeyhole,
  MessageSquareText,
  PencilLine,
  Pill,
  Route,
  Search,
  ShieldCheck,
  Wrench,
  ChevronDown,
  X,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ActivityKind } from "@shared/activity";
import { agents } from "@shared/agents";
import { motionTokens } from "@/components/arc/motion-tokens";
import { TextShimmer } from "@/components/arc/text-shimmer/text-shimmer";
import { useI18n } from "@/i18n";
import type { Dict } from "@/i18n/fr";
import { countedSteps, type ActivityStep, type TurnActivity } from "./activity";
import styles from "./activity.module.css";

const ICONS: Record<ActivityKind, LucideIcon> = {
  privacy: LockKeyhole,
  routing: Route,
  agent: MessageSquareText,
  search: Search,
  read: FileText,
  tool: Wrench,
  handoff: ArrowRightLeft,
  language: Languages,
  safety: ShieldCheck,
  rewrite: PencilLine,
  waiting: Hourglass,
  location: MapPin,
  places: MapPinned,
  appointments: CalendarSearch,
  drugs: Pill,
  agent_status: MessageSquareText,
  question: MessageCircleQuestionMark,
  answer: Reply,
};

const agentName = (id: string | undefined) => (id ? (agents.get(id)?.name ?? "Agent Santé") : "Agent Santé");

/** The label of a step, from its kind and structured params only. */
export function stepLabel(step: ActivityStep, t: Dict): string {
  const a = t.chat.activity;
  const p = step.params;
  switch (step.kind) {
    case "privacy":
      return a.privacy;
    case "routing":
      return a.routing(agentName(p.agent), p.via === "direct");
    case "agent":
      return a.agent(agentName(p.agent));
    case "search":
      return a.search(p.query ?? "");
    case "read":
      return a.read(p.title ?? "");
    case "tool":
      return a.tool(p.tool ?? "?");
    case "handoff":
      return a.handoff(agentName(p.agent));
    case "language":
      return a.language(p.lang === "fr");
    case "safety":
      return a.safety;
    case "rewrite":
      return a.rewrite(p.attempt ?? 2, p.of ?? 3);
    case "waiting":
      return a.waiting;
    case "location":
      return a.location(p.area ?? "");
    case "places":
      return a.places;
    case "appointments":
      return a.appointments;
    case "drugs":
      return a.drugs;
    case "agent_status":
      return p.text ?? "";
    case "question":
      return a.question;
    case "answer":
      return a.answer(p.via === "choice");
  }
}

function seconds(ms: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.max(0, ms) / 1000);
}

function Spinner() {
  return (
    <svg className={styles.spin} width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity=".2" strokeWidth="1.75" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/** The tick draws itself once when a step ends live; a settled list shows it drawn. */
function Tick({ draw }: { draw: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <motion.path
        d="M3.5 8.5 6.5 11.5 12.5 5"
        initial={draw ? { pathLength: 0 } : false}
        animate={{ pathLength: 1 }}
        transition={{ duration: motionTokens.duration.standard, ease: [...motionTokens.ease.standard] }}
      />
    </svg>
  );
}

function StateIcon({ state, draw }: { state: ActivityStep["state"]; draw: boolean }) {
  if (state === "running") return <Spinner />;
  if (state === "done") return <Tick draw={draw} />;
  return <X size={16} strokeWidth={1.75} aria-hidden="true" />;
}

function Rows({ steps, live }: { steps: ActivityStep[]; live: boolean }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const enter = reduced ? { opacity: 0 } : { opacity: 0, y: 6 };
  const transition = reduced ? { duration: motionTokens.duration.fast } : motionTokens.spring.smooth;
  return (
    <ol className={styles.list} aria-label={t.chat.activity.listLabel}>
      <AnimatePresence initial={false}>
        {steps.map((step) => {
          const Icon = ICONS[step.kind];
          const label = stepLabel(step, t);
          const running = step.state === "running";
          // The agent's own status line: its face and its voice (italic), no state icon.
          if (step.kind === "agent_status") {
            return (
              <motion.li key={step.id} className={styles.step} data-kind="agent_status" initial={live ? enter : false} animate={{ opacity: 1, y: 0 }} transition={transition}>
                <span className={styles.mark}>
                  <img className={styles.face} src="/avatar.svg" alt="" width={14} height={14} />
                </span>
                <span className={styles.label}>
                  <span className="sr-only">{t.chat.activity.agentSays("")}</span>
                  <q className={styles.voice}>{label}</q>
                </span>
              </motion.li>
            );
          }
          return (
            <motion.li
              key={step.id}
              className={styles.step}
              data-state={step.state}
              data-kind={step.kind}
              initial={live ? enter : false}
              animate={{ opacity: 1, y: 0 }}
              transition={transition}
            >
              <span className={styles.mark}>
                <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span className={styles.label}>
                {live && running ? (
                  <TextShimmer active as="span">
                    {label}
                  </TextShimmer>
                ) : (
                  label
                )}
                <span className="sr-only">, {t.chat.activity.states[step.state]}</span>
              </span>
              {step.end !== undefined && !running && (
                <span className={styles.time}>{t.chat.activity.seconds(seconds(step.end - step.start, t.meta.locale))}</span>
              )}
              <span className={styles.state}>
                <StateIcon state={step.state} draw={live && !reduced} />
              </span>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}

/** The group: a header button with the marks, the count and the time, and the rows under it. */
function ActivityGroup({ steps, live, totalMs }: { steps: ActivityStep[]; live: boolean; totalMs?: number }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const id = useId();
  const [open, setOpen] = useState(live);
  const counted = countedSteps(steps);
  // Each kind shows once in the stack, in the order of first use.
  const kinds = [...new Set(counted.map((s) => s.kind))];
  const shown = kinds.slice(0, 4);
  const a = t.chat.activity;
  const title = live ? a.working(counted.length) : a.summary(counted.length, seconds(totalMs ?? 0, t.meta.locale));
  const height = reduced ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } };
  return (
    <div className={styles.group} data-live={live || undefined} data-open={open || undefined}>
      <button type="button" className={styles.head} aria-expanded={open} aria-controls={`${id}-rows`} onClick={() => setOpen(!open)}>
        <span className={styles.stack} aria-hidden="true">
          {shown.map((kind, i) => {
            const Icon = ICONS[kind];
            return (
              <span key={kind} className={styles.stackItem} style={{ zIndex: i + 1 }}>
                <Icon size={12} strokeWidth={1.75} />
              </span>
            );
          })}
          {kinds.length > shown.length && <span className={styles.stackMore}>+{kinds.length - shown.length}</span>}
        </span>
        {live ? (
          <TextShimmer active as="span" className={styles.title}>
            {title}
          </TextShimmer>
        ) : (
          <span className={styles.title}>{title}</span>
        )}
        <ChevronDown size={16} strokeWidth={1.75} className={styles.chevron} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="rows"
            id={`${id}-rows`}
            className={styles.clip}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={height}
          >
            <Rows steps={steps} live={live} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Live steps under the typing bubble: the group, open. */
export function ActivityList({ steps, live }: { steps: ActivityStep[]; live: boolean }) {
  if (!steps.length) return null;
  return <ActivityGroup steps={steps} live={live} />;
}

/** Under a checked reply: the group, folded ("5 étapes · 7,2 s"). */
export function ActivitySummary({ activity }: { activity: TurnActivity }) {
  if (!countedSteps(activity.steps).length) return null;
  return (
    <div className={styles.summary}>
      <ActivityGroup steps={activity.steps} live={false} totalMs={activity.totalMs} />
    </div>
  );
}
