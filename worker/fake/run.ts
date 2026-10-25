// Fake Run for local development only (FAKE_UPSTREAMS=1, refused in production).
// It answers from canned, official-style replies and plays the custom events, so
// the full pipeline (handoff, language switch, rewrites) runs without the network.
import { agents } from "../../shared/agents";
import type { CallOptions, Reply, RunApi, RunQuestion, TurnBody } from "../run/client";
import { RunError } from "../run/client";
import { zeroUsage, type RunUsage } from "../costs";

interface FakeRun {
  id: string;
  agent: string;
  status: Reply["status"];
  seq: number;
  /** Normalized text of the last user message, used to pick the rewrite. */
  topic: string;
  /** Cumulative usage, like Run. Made-up numbers of a typical Haiku turn with prompt caching. */
  usage: RunUsage;
}

const MODEL = "anthropic/claude-haiku-5-5";

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** The last user message of a transcript input, or the whole input. */
function lastUserMessage(input: string): string {
  const parts = input.split(/\n\n(?:Personne : |Person: )/);
  return parts.length > 1 ? parts.at(-1)! : input;
}

interface Canned {
  text?: string;
  /** A clarifying question (Run ask with choices). */
  question?: RunQuestion;
  handoff?: { to: string; reason: string };
  switchLanguage?: { to: string };
}

/** The vaccine specialist of a language in the synced catalog (its id changes with agents.json). */
export function vaccineAgent(lang: "fr" | "en"): string {
  const list = agents.catalog.agents.filter((a) => a.lang === lang && a.id !== agents.entry(lang));
  return (list.find((a) => /vacc/i.test(a.id)) ?? list[0] ?? { id: agents.entry(lang) }).id;
}

function answer(agent: string, message: string): Canned {
  const fr = agent.startsWith("fr/");
  const m = norm(message);
  // The recap request of the app: the four sections of the planned format.
  if (/^\[(recapitulatif demande|recap requested)\]/.test(m)) {
    return {
      text: fr
        ? "## Ce qui vous amène\n\nVous cherchiez où consulter pour la fièvre d'un enfant.\n\n## Recommandations officielles\n\nLa page Québec.ca sur la fièvre explique quand consulter : [Fièvre chez l'enfant](https://www.quebec.ca/sante/problemes-de-sante/a-z/fievre).\n\n## Prochaines étapes\n\n- Info-Santé 811 peut vous conseiller jour et nuit.\n- Une pharmacie ou une clinique de votre secteur peut aussi vous aider.\n\n## Questions à poser à votre médecin\n\n- [ ] Quels signes doivent m'amener à reconsulter ?\n- [ ] Combien de temps la fièvre dure-t-elle en général ?"
        : "## What brings you\n\nYou were looking for where to get care for a child's fever.\n\n## Official recommendations\n\nThe Québec.ca page on fever explains when to see a doctor: [Fever in children](https://www.quebec.ca/en/health/health-issues/a-z/fever).\n\n## Next steps\n\n- Info-Santé 811 can advise you day and night.\n- A pharmacy or a clinic in your area can also help.\n\n## Questions for your doctor\n\n- [ ] Which signs should make me come back?\n- [ ] How long does a fever usually last?",
    };
  }
  if (fr && /\b(english|in english|anglais)\b/.test(m)) return { switchLanguage: { to: "en" } };
  if (!fr && /\b(francais|french|en francais)\b/.test(m)) return { switchLanguage: { to: "fr" } };
  if (agent.endsWith("/concierge") && /(vaccin|vaccine|grippe|flu)/.test(m)) {
    return fr
      ? { handoff: { to: vaccineAgent("fr"), reason: "Question sur le vaccin contre la grippe" } }
      : { handoff: { to: vaccineAgent("en"), reason: "Question about the flu vaccine" } };
  }
  // "J'ai de la fièvre, où aller ?" does not say who is sick: the agent asks first.
  if (/(\bj.ai de la fievre|\bi have a fever|demo-question)/.test(m)) {
    return {
      question: fr
        ? {
            question_id: "q_fake",
            text: "Pour qui cherchez-vous de l'information ?",
            choices: ["Pour moi (adulte)", "Pour un enfant", "Pour un bébé de moins de 1 an"],
          }
        : { question_id: "q_fake", text: "Who is this for?", choices: ["For me (adult)", "For a child", "For a baby under 1"] },
    };
  }
  if (m.includes("demo-conseil") || m.includes("demo-trois")) {
    return {
      text: fr
        ? "Prenez 500 mg d'acétaminophène toutes les 6 heures et vous n'avez pas besoin de consulter."
        : "Take 500 mg of acetaminophen every 6 hours and you do not need to see a doctor.",
    };
  }
  if (/(fievre|fever)/.test(m)) {
    return {
      text: fr
        ? "La fièvre est fréquente chez les enfants. La page **Fièvre chez l'enfant** de Québec.ca explique comment prendre la température et dans quelles situations il faut consulter.\n\n" +
          "Pour savoir où aller ce soir, vous pouvez :\n\n" +
          "- appeler **Info-Santé 811** (option 1) pour parler à une infirmière ;\n" +
          "- consulter la page *Quand consulter à l'urgence* ;\n" +
          "- en cas de difficulté à respirer ou de somnolence inhabituelle, appeler le **911**.\n\n" +
          "Je peux aussi vous aider à [trouver une clinique ouverte près de chez vous](agentsante://Trouver une clinique ouverte près de chez moi).\n\n" +
          "Sources : [Fièvre chez l'enfant](https://www.quebec.ca/sante/problemes-de-sante/a-z/fievre-chez-enfant), " +
          "[Quand consulter à l'urgence](https://www.quebec.ca/sante/systeme-et-services-de-sante/organisation-des-services/services-de-sante-et-services-sociaux-de-premiere-ligne/quand-consulter-a-lurgence), " +
          "[Info-Santé 811](https://www.quebec.ca/sante/trouver-une-ressource/info-sante-811)"
        : "Fever is common in children. The **Fever in children** page on Québec.ca explains how to take a temperature and when to see a health professional.\n\n" +
          "To know where to go tonight, you can:\n\n" +
          "- call **Info-Santé 811** (option 1) to talk to a nurse;\n" +
          "- read the page on pre-hospital emergency care;\n" +
          "- if your child has trouble breathing or is unusually drowsy, call **911**.\n\n" +
          "I can also help you [find an open clinic near you](agentsante://Find an open clinic near me).\n\n" +
          "Sources: [Fever in children](https://www.quebec.ca/en/health/health-issues/a-z/fever-children), " +
          "[Info-Santé 811](https://www.quebec.ca/en/health/finding-a-resource/info-sante-811)",
    };
  }
  if (/(medecin de famille|family doctor|gamf)/.test(m)) {
    return {
      text: fr
        ? "Pour avoir un médecin de famille au Québec, il faut s'inscrire au **Guichet d'accès à un médecin de famille (GAMF)**. L'inscription est gratuite. Il vous faut votre carte d'assurance maladie.\n\n" +
          "En attendant, le **Guichet d'accès à la première ligne (GAP)** peut vous orienter vers un rendez-vous selon votre besoin : on le joint par le 811.\n\n" +
          "Sources : [Inscription auprès d'un médecin de famille](https://www.quebec.ca/sante/trouver-une-ressource/inscription-aupres-dun-medecin-de-famille), [GAMF](https://www.gamf.gouv.qc.ca)"
        : "To get a family doctor in Québec, register with the **Québec Family Doctor Finder (GAMF)**. Registration is free. You need your health insurance card.\n\n" +
          "Meanwhile, the **primary care access point (GAP)** can direct you to an appointment based on your need: you reach it through 811.\n\n" +
          "Sources: [Registering with a family doctor](https://www.quebec.ca/en/health/finding-a-resource/registering-with-a-family-doctor), [Québec Family Doctor Finder](https://www.quebec.ca/en/health/finding-a-resource/quebec-family-doctor-finder)",
    };
  }
  if (/(vaccin|vaccine|grippe|flu)/.test(m)) {
    return {
      text: fr
        ? "La vaccination contre la grippe est **gratuite** pour plusieurs groupes, dont les personnes de 60 ans et plus, les personnes avec certaines maladies chroniques, les femmes enceintes et leurs proches.\n\n" +
          "Vous pouvez prendre rendez-vous en ligne sur **Clic Santé**, ou demander à votre pharmacie si elle offre le vaccin.\n\n" +
          "Source : [Vaccination contre la grippe](https://www.quebec.ca/sante/conseils-et-prevention/vaccination/vaccination-contre-la-grippe)"
        : "Flu vaccination is **free** for several groups, including people aged 60 and over, people with some chronic diseases, pregnant women and the people close to them.\n\n" +
          "You can book online on **Clic Santé**, or ask your pharmacy if it offers the vaccine.\n\n" +
          "Source: [Flu vaccination](https://www.quebec.ca/en/health/advice-and-prevention/vaccination/flu-vaccine)",
    };
  }
  return {
    text: fr
      ? "Je peux vous aider à trouver l'information officielle et le bon service. Pour parler à une infirmière, appelez **Info-Santé 811**. Pour un besoin psychosocial, appelez **Info-Social 811, option 2**.\n\n" +
        "Pouvez-vous préciser votre question ? Par exemple : où consulter, comment prendre rendez-vous ou comment se faire vacciner.\n\n" +
        "Source : [Info-Santé 811](https://www.quebec.ca/sante/trouver-une-ressource/info-sante-811)"
      : "I can help you find official information and the right service. To talk to a nurse, call **Info-Santé 811**. For a psychosocial need, call **Info-Social 811, option 2**.\n\n" +
        "Can you tell me more? For example: where to go, how to book an appointment or how to get vaccinated.\n\n" +
        "Source: [Info-Santé 811](https://www.quebec.ca/en/health/finding-a-resource/info-sante-811)",
  };
}

function rewrite(agent: string, topic: string): string {
  const fr = agent.startsWith("fr/");
  if (topic.includes("demo-trois")) return fr ? "Prenez 2 comprimés maintenant." : "Take 2 tablets now.";
  return fr
    ? "Je ne peux pas vous dire quel médicament prendre ni à quelle dose. Un pharmacien peut vous conseiller sans rendez-vous, et **Info-Santé 811** peut vous orienter.\n\n" +
        "Source : [Info-Santé 811](https://www.quebec.ca/sante/trouver-une-ressource/info-sante-811)"
    : "I cannot tell you which medication to take or at what dose. A pharmacist can advise you without an appointment, and **Info-Santé 811** can direct you.\n\n" +
        "Source: [Info-Santé 811](https://www.quebec.ca/en/health/finding-a-resource/info-sante-811)";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Search query and document title of the fake work rows, by topic. */
function workFor(message: string, fr: boolean): { query: string; title: string } {
  const m = norm(message);
  if (/(fievre|fever)/.test(m))
    return fr
      ? { query: "fièvre enfant où consulter", title: "Fièvre chez l'enfant" }
      : { query: "fever child where to go", title: "Fever in children" };
  if (/(vaccin|vaccine|grippe|flu)/.test(m))
    return fr
      ? { query: "vaccin grippe gratuit", title: "Vaccination contre la grippe" }
      : { query: "free flu vaccine", title: "Flu vaccination" };
  if (/(medecin de famille|family doctor|gamf)/.test(m))
    return fr
      ? { query: "médecin de famille inscription", title: "Inscription auprès d'un médecin de famille" }
      : { query: "register family doctor", title: "Registering with a family doctor" };
  return fr ? { query: "Info-Santé 811", title: "Info-Santé 811" } : { query: "Info-Santé 811", title: "Info-Santé 811" };
}

/** Calls one Worker tool (POST /tools/v1/<op>) with the tools secret. Local dev only. */
export type FakeToolCall = (op: string, body: Record<string, unknown>) => Promise<unknown>;

const PLACE_MARKER = /(?:lieu : |place: )(ref-[a-z]{12})/;

/**
 * Plays the place tools like a real agent: a message with a place marker and a vaccine or clinic
 * question calls the Worker tools, then gets a short summary. The lists go to the attachments.
 */
async function placeTools(
  agent: string,
  message: string,
  tools: FakeToolCall,
  emit: (data: Record<string, unknown>) => void,
): Promise<string | null> {
  const near = PLACE_MARKER.exec(message)?.[1];
  if (!near) return null;
  const fr = agent.startsWith("fr/");
  const lang = fr ? "fr" : "en";
  const m = norm(message);
  if (/(vaccin|vaccine|grippe|flu|covid)/.test(m)) {
    await tools("appointments_link", { service: "vaccination-virus-respiratoires", near, lang });
    emit({ text: "Called appointments_link" });
    await tools("places_search", { service: "vaccination", near, lang, limit: 8 });
    emit({ text: "Called places_search" });
    return fr
      ? "Voici les lieux près de votre secteur. Le bouton ci-dessous ouvre la liste des disponibilités sur Clic Santé : la réservation se fait là-bas, par vous.\n\nSource : [Vaccination contre la grippe](https://www.quebec.ca/sante/conseils-et-prevention/vaccination/vaccination-contre-la-grippe)"
      : "Here are places near your area. The button below opens the list of available times on Clic Santé: you book there yourself.\n\nSource: [Flu vaccination](https://www.quebec.ca/en/health/advice-and-prevention/vaccination/flu-vaccine)";
  }
  if (/(clinique|clinic|clsc|pharmacie|pharmacy|pres de|near)/.test(m)) {
    const kind = /pharmac/.test(m) ? "pharmacy" : /clsc/.test(m) ? "clsc" : undefined;
    const r = (await tools("places_search", { kind, near, lang, limit: 10, radius_km: 15 })) as { count?: number };
    emit({ text: "Called places_search" });
    return fr
      ? `J'ai trouvé ${r.count ?? 0} établissements près de votre secteur. La liste et la carte sont sous ce message.\n\nSource : [Répertoire des ressources en santé](https://sante.gouv.qc.ca/repertoire-ressources/)`
      : `I found ${r.count ?? 0} places near your area. The list and the map are under this message.\n\nSource: [Health resources directory](https://sante.gouv.qc.ca/en/repertoire-ressources/)`;
  }
  return null;
}

export function fakeRun(options: { delayMs?: number; tools?: FakeToolCall } = {}): RunApi & { runs: Map<string, FakeRun> } {
  const runs = new Map<string, FakeRun>();
  const total = options.delayMs ?? 900;
  const delay = () => wait(total);
  let counter = 0;

  /**
   * Plays Run work rows like a real turn: a knowledge search, then a read, with the same English
   * phrases as Run. Real agents send these rows only with work_session: true.
   * "demo-lent" also plays one heartbeat.
   */
  const work = async (run: FakeRun, message: string, canned: Canned, call?: CallOptions) => {
    const emit = (data: Record<string, unknown>) =>
      call?.onEvent?.({ seq: ++run.seq, type: "run.progress", run_id: run.id, agent: run.agent, data });
    if (!call?.onEvent || (!canned.text && !canned.question)) return delay();
    const fr = run.agent.startsWith("fr/");
    const { query, title } = workFor(message, fr);
    const step = total / 3;
    const searchId = `call_${run.id}_${run.seq}_s`;
    const readId = `call_${run.id}_${run.seq}_r`;
    await wait(step * 0.4);
    if (norm(message).includes("demo-lent")) {
      emit({ text: "Still working", heartbeat: true });
      await wait(step * 2);
    }
    // The agent's status line comes in the same step as the search (custom event status).
    call?.onEvent?.({
      seq: ++run.seq,
      type: "event.status",
      run_id: run.id,
      agent: run.agent,
      data: { text: fr ? `Je cherche dans les pages de Québec.ca : ${query}` : `I am searching the Québec.ca pages: ${query}` },
    });
    emit({ text: `Searching knowledge for ${query}`, tool: "knowledge_search", call_id: searchId, state: "running" });
    await wait(step);
    emit({ text: `Searched knowledge for ${query}`, tool: "knowledge_search", call_id: searchId, state: "done" });
    await wait(step * 0.3);
    emit({ text: `Reading ${title}`, tool: "knowledge_read", call_id: readId, state: "running" });
    await wait(step * 0.8);
    emit({ text: `Read ${title}`, tool: "knowledge_read", call_id: readId, state: "done" });
    await wait(step * 0.5);
  };

  const withTools = async (run: FakeRun, message: string, canned: Canned, call?: CallOptions) => {
    if (!options.tools || !canned.text) return;
    const emit = (data: Record<string, unknown>) =>
      call?.onEvent?.({ seq: ++run.seq, type: "run.progress", run_id: run.id, agent: run.agent, data });
    try {
      const text = await placeTools(run.agent, message, options.tools, emit);
      if (text) canned.text = text;
    } catch {
      // The tools are a bonus in local dev.
    }
  };

  const reply = (run: FakeRun, canned: Canned): Reply => {
    run.seq += 4;
    const u = run.usage;
    u.input_tokens += 9_000;
    u.cached_input_tokens += 6_500;
    u.output_tokens += 320;
    u.model_cost_usd = Math.round((u.model_cost_usd + 0.0048) * 1e6) / 1e6;
    u.credits += 12; // one run minute (10) and one knowledge search (2)
    return {
      runId: run.id,
      status: "waiting",
      lastSeq: run.seq,
      model: MODEL,
      text: canned.text ?? "",
      ...(canned.question ? { question: { ...canned.question, question_id: `q_${run.id}_${run.seq}` } } : {}),
      handoff: canned.handoff,
      switchLanguage: canned.switchLanguage,
    };
  };

  return {
    runs,
    async start(agent, input, _key, call) {
      const message = lastUserMessage(input);
      const run: FakeRun = { id: `run_fake_${++counter}`, agent, status: "waiting", seq: 0, topic: norm(message), usage: zeroUsage() };
      runs.set(run.id, run);
      // A start that carries a rewrite request (run ended between turns) gets the rewrite.
      if (/\[(Vérification automatique|Automatic check)\]/.test(input)) {
        await delay();
        return reply(run, { text: rewrite(agent, run.topic) });
      }
      const canned = answer(agent, message);
      await work(run, message, canned, call);
      await withTools(run, message, canned, call);
      return reply(run, canned);
    },
    async turn(runId, body: TurnBody, _key, call) {
      // An answer to the fake question: the agent now knows who it is for, and answers on fever.
      const input = typeof body === "string" ? body : `fièvre fever ${body.answer.value}`;
      const run = runs.get(runId);
      if (!run) throw new RunError(404, "run_not_found", "No such run.");
      if (run.status !== "waiting") throw new RunError(409, "run_terminal", "Run ended.");
      if (/^\[(Vérification automatique|Automatic check)\]/.test(input)) {
        await delay();
        return reply(run, { text: rewrite(run.agent, run.topic) });
      }
      run.topic = norm(input);
      const canned = answer(run.agent, input);
      await work(run, input, canned, call);
      await withTools(run, input, canned, call);
      return reply(run, canned);
    },
    async cancel(runId) {
      const run = runs.get(runId);
      if (run) run.status = "cancelled";
    },
    async usage(runId) {
      const run = runs.get(runId);
      return run ? { ...run.usage } : null;
    },
  };
}
