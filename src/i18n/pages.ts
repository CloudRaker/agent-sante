// Content of the static pages: about, privacy and terms, in fr-CA and en-CA.
import type { Lang } from "@shared/api";
import type { PageId } from "@shared/paths";

export const LINKS = {
  cloudraker: "https://cloudraker.com",
  webRepo: "https://github.com/CloudRaker/agent-sante",
  agentsRepo: "https://github.com/CloudRaker/agent-sante-agents",
  milliseconds: "https://milliseconds.ai",
  run: "https://run.cloudraker.com",
  quebecHealth: { fr: "https://www.quebec.ca/sante", en: "https://www.quebec.ca/en/health" },
  info811: {
    fr: "https://www.quebec.ca/sante/trouver-une-ressource/info-sante-811",
    en: "https://www.quebec.ca/en/health/finding-a-resource/info-sante-811",
  },
  security: "https://github.com/CloudRaker/agent-sante/security/policy",
} as const;

export interface PageLink {
  label: string;
  href: string;
}

export interface PageSection {
  heading: string;
  paragraphs: string[];
  list?: string[];
  links?: PageLink[];
}

export interface PageContent {
  title: string;
  lead: string;
  updated: string;
  sections: PageSection[];
}

export type { PageId, RoutePageId, ToolPageId } from "@shared/paths";
export { PAGE_PATHS } from "@shared/paths";

export const pages: Record<Lang, Record<PageId, PageContent> & { updatedLabel: string }> = {
  fr: {
    updatedLabel: "Dernière mise à jour",
    about: {
      title: "À propos d'Agent Santé",
      lead: "Agent Santé aide les gens à trouver l'information santé officielle du Québec quand la ligne Info-Santé 811 est très occupée.",
      updated: "23 octobre 2026",
      sections: [
        {
          heading: "Pourquoi ce site",
          paragraphs: [
            "En période de pointe, les délais d'attente au 811 peuvent être longs. Beaucoup de questions portent sur l'information générale : où consulter, comment prendre rendez-vous, qui peut recevoir un vaccin gratuit. Cette information existe déjà sur les sites officiels, mais elle est parfois difficile à trouver.",
            "Agent Santé répond à ces questions à partir des pages de Québec.ca, de Santé Québec, de l'INSPQ et des documents du ministère de la Santé. Chaque réponse donne le lien vers sa source, pour que vous puissiez vérifier.",
          ],
        },
        {
          heading: "Ce qu'Agent Santé ne fait pas",
          paragraphs: [
            "Agent Santé ne pose pas de diagnostic, ne recommande pas de traitement et ne donne pas de dose de médicament. Si une réponse contient un conseil médical personnel, elle est retirée et l'agent doit la réécrire. Pour un avis sur votre situation, appelez Info-Santé au 811. En cas d'urgence, appelez le 911.",
          ],
        },
        {
          heading: "Comment ça fonctionne",
          paragraphs: [
            "Les agents fonctionnent sur CloudRaker Run. Un agent d'accueil comprend votre question et la confie à un agent spécialisé (virus respiratoires, vaccination, aînés, santé mentale et autres). Chaque agent existe en français et en anglais.",
            "Avant d'envoyer votre message aux agents, Decision-machine-1, un modèle de CloudRaker hébergé à Montréal, vérifie qu'il ne contient pas de renseignements personnels. Il vérifie aussi que la réponse ne contient pas de conseil médical personnel.",
          ],
        },
        {
          heading: "Données ouvertes utilisées",
          paragraphs: [
            "Positions des codes postaux : « CP Territoires », Institut de la statistique du Québec (mai 2026), sous licence Creative Commons Attribution 4.0 (CC BY 4.0).",
            "Établissements : le Répertoire des ressources en santé et services sociaux du gouvernement du Québec (sante.gouv.qc.ca). Chaque établissement donne le lien vers sa fiche officielle.",
            "Rendez-vous : Agent Santé donne seulement un lien vers la page de résultats de Clic Santé. Il ne lit pas les disponibilités et ne prend aucun rendez-vous.",
            "Carte : Apple Plans (MapKit JS).",
          ],
          links: [
            { label: "CP Territoires (Données Québec)", href: "https://www.donneesquebec.ca/recherche/dataset/1a6267da-82ed-4ea0-b35d-9e9618a58ce7" },
            { label: "Licence CC BY 4.0", href: "https://creativecommons.org/licenses/by/4.0/deed.fr" },
            { label: "Répertoire des ressources", href: "https://sante.gouv.qc.ca/repertoire-ressources/" },
          ],
        },
        {
          heading: "Un projet libre et bénévole",
          paragraphs: [
            "CloudRaker a créé Agent Santé bénévolement. Le code du site et les instructions des agents sont publics, sous licence Apache 2.0 : tout le monde peut les lire et les vérifier.",
            "Agent Santé n'est pas un service du gouvernement du Québec ni de Santé Québec, et n'a aucun lien avec eux.",
          ],
          links: [
            { label: "Code du site sur GitHub", href: LINKS.webRepo },
            { label: "Instructions des agents sur GitHub", href: LINKS.agentsRepo },
            { label: "CloudRaker", href: LINKS.cloudraker },
          ],
        },
      ],
    },
    privacy: {
      title: "Politique de confidentialité",
      lead: "Agent Santé est conçu pour garder le moins de données possible, le moins longtemps possible. Voici ce qui se passe avec vos messages.",
      updated: "25 octobre 2026",
      sections: [
        {
          heading: "En bref",
          paragraphs: [],
          list: [
            "Aucun compte, aucun téléversement, aucun témoin (cookie) de suivi ou de statistiques.",
            "La conversation reste dans la mémoire de cette fenêtre. Si vous la rechargez ou la fermez, elle prend fin.",
            "Vos échanges sont effacés environ 10 minutes après la fin de la conversation.",
            "Les messages qui contiennent des renseignements personnels sont bloqués avant d'atteindre les modèles de langue.",
          ],
        },
        {
          heading: "Où vont vos messages",
          paragraphs: [
            "1. Votre navigateur envoie le message au serveur d'Agent Santé, hébergé par Cloudflare.",
            "2. Le serveur remplace d'abord un code postal par son secteur (voir plus bas). Il cherche ensuite les numéros, les courriels et les dates de naissance. Puis Decision-machine-1, un modèle de CloudRaker hébergé à Montréal, cherche les autres renseignements personnels, comme un nom ou une adresse. Si un renseignement personnel est trouvé, le message est bloqué.",
            "3. Si le message passe le filtre, il va aux agents de CloudRaker Run. Les modèles de langue fonctionnent sur des serveurs au Canada et aux États-Unis, et peuvent lire le texte de vos messages.",
            "4. Decision-machine-1 vérifie la réponse de l'agent avant qu'elle s'affiche, pour retirer tout conseil médical personnel.",
            "Un message vocal fait d'abord un détour : votre navigateur envoie l'enregistrement à notre serveur, qui le fait transcrire à Montréal par rakeaudio, le modèle de transcription de CloudRaker. Le texte revient à votre navigateur, puis suit les étapes 1 à 4 comme un message écrit. Si le filtre le bloque, le texte revient dans la zone de message pour que vous le corrigiez.",
          ],
        },
        {
          heading: "Votre code postal",
          paragraphs: [
            "Le code postal est le seul renseignement personnel accepté, et seulement pour trouver un service ou un rendez-vous près de chez vous. Donnez-le seulement si vous le voulez.",
            "Notre serveur retire le code postal de votre message avant toute autre étape. Le filtre et le modèle d'IA voient seulement votre secteur (les 3 premiers caractères, par exemple H2X), ainsi que le nom de votre municipalité et de votre territoire de CLSC.",
            "Le serveur trouve la position du code dans les données ouvertes de l'Institut de la statistique du Québec. Il ne garde pas le code : il garde seulement cette position et votre secteur, pendant votre conversation, puis il les efface (au plus 15 minutes après votre dernier message).",
            "Pour chercher des établissements, le serveur envoie au répertoire des ressources en santé une position arrondie à environ 100 m. Le lien vers Clic Santé utilise la même position arrondie, jamais votre code postal. La carte (Apple Plans) reçoit seulement les positions des établissements.",
            "Agent Santé ne prend jamais de rendez-vous pour vous. Vous réservez vous-même sur Clic Santé.",
          ],
        },
        {
          heading: "Combien de temps",
          paragraphs: [
            "Votre session dure 10 minutes après votre dernier message. La conversation prend fin quand vous cliquez sur « Terminer », quand vous fermez ou rechargez l'onglet, ou après 10 minutes sans activité. Elle est alors annulée chez CloudRaker Run. Vos échanges sont effacés environ 10 minutes après la fin de la conversation.",
            "Le serveur d'Agent Santé ne garde pas le texte de vos messages. Ses journaux contiennent seulement des numéros de requête, des codes d'état et des durées, jamais le contenu.",
          ],
        },
        {
          heading: "Messages vocaux, récapitulatif et statistiques",
          paragraphs: [
            "Le bouton micro enregistre un message vocal. Votre navigateur demande la permission d'utiliser le micro la première fois que vous le touchez, jamais avant. L'enregistrement dure au plus une minute.",
            "Le son va seulement à notre serveur, puis à rakeaudio, le modèle de transcription de CloudRaker, à Montréal. Ni notre serveur ni rakeaudio ne gardent le son ou le texte. Nos journaux contiennent seulement la taille, la durée et le temps de traitement. Le son ne va jamais aux modèles de langue : seul le texte transcrit continue, et il passe par le filtre des renseignements personnels comme un message écrit.",
            "Les pages Transparence et Coûts montrent seulement des totaux, comme le nombre de messages bloqués. Aucun texte n'y est gardé.",
            "Récapitulatif PDF : seulement si vous le demandez, l'agent écrit un résumé de la conversation, vérifié comme ses autres réponses. Notre serveur le fait mettre en page par markdowntopdf.dev, un service de CloudRaker qui ne garde rien, puis le PDF va seulement à votre navigateur. Il n'est enregistré nulle part ailleurs.",
          ],
        },
        {
          heading: "Protection contre les robots et les abus",
          paragraphs: [
            "Une vérification de Cloudflare confirme que vous n'êtes pas un robot avant la conversation. Votre adresse IP sert à limiter le nombre de requêtes, pour protéger le service. Agent Santé ne la conserve pas.",
          ],
        },
        {
          heading: "Vos choix",
          paragraphs: [
            "Votre navigateur garde seulement vos préférences de langue et d'affichage, pour vos prochaines visites. Vous pouvez les effacer dans ses réglages.",
            "Pour une question sur cette politique, écrivez-nous par GitHub.",
          ],
          links: [{ label: "Ouvrir une question sur GitHub", href: `${LINKS.webRepo}/issues` }],
        },
      ],
    },
    terms: {
      title: "Conditions d'utilisation",
      lead: "En utilisant Agent Santé, vous acceptez ces conditions.",
      updated: "23 octobre 2026",
      sections: [
        {
          heading: "Pas un service d'urgence",
          paragraphs: [
            "Agent Santé n'est pas un service d'urgence. En cas d'urgence, appelez le 911. Pour parler à une infirmière, appelez Info-Santé au 811. Pour un besoin psychosocial, appelez Info-Social au 811, option 2. En cas d'intoxication, appelez le Centre antipoison du Québec au 1 800 463-5060.",
          ],
        },
        {
          heading: "Pas un service gouvernemental",
          paragraphs: [
            "Agent Santé est un projet bénévole de CloudRaker. Il n'a aucun lien avec le gouvernement du Québec, le ministère de la Santé et des Services sociaux ni Santé Québec. Les sources citées appartiennent à leurs auteurs.",
          ],
        },
        {
          heading: "Information générale seulement",
          paragraphs: [
            "Agent Santé donne de l'information générale tirée de sources officielles et vous oriente vers les services. Il ne donne pas d'avis médical, ne pose pas de diagnostic et ne remplace pas un professionnel de la santé. Les réponses sont produites automatiquement et peuvent contenir des erreurs : vérifiez toujours la source officielle.",
          ],
        },
        {
          heading: "Aucune responsabilité",
          paragraphs: [
            "CloudRaker fournit Agent Santé tel quel, sans garantie. CloudRaker n'assume aucune responsabilité pour une décision prise à partir des réponses, ni pour une interruption du service.",
          ],
        },
        {
          heading: "Bon usage",
          paragraphs: [
            "N'écrivez pas de renseignements personnels. N'utilisez pas le service pour des abus, des envois automatisés ou pour contourner ses vérifications. Le service peut bloquer un message ou mettre fin à une conversation.",
          ],
        },
        {
          heading: "Code libre",
          paragraphs: ["Le code d'Agent Santé est publié sous licence Apache 2.0."],
          links: [{ label: "Code du site sur GitHub", href: LINKS.webRepo }],
        },
      ],
    },
  },
  en: {
    updatedLabel: "Last updated",
    about: {
      title: "About Agent Santé",
      lead: "Agent Santé helps people find official Québec health information when the Info-Santé 811 line is very busy.",
      updated: "October 23, 2026",
      sections: [
        {
          heading: "Why this site",
          paragraphs: [
            "At peak times, the wait at 811 can be long. Many questions are about general information: where to go, how to book an appointment, who can get a free vaccine. This information is already on the official sites, but it is sometimes hard to find.",
            "Agent Santé answers these questions from the pages of Québec.ca, Santé Québec, INSPQ and the documents of the Ministère de la Santé. Every answer gives the link to its source, so you can check it.",
          ],
        },
        {
          heading: "What Agent Santé does not do",
          paragraphs: [
            "Agent Santé does not make a diagnosis, does not recommend a treatment and does not give a medication dose. If an answer contains personal medical advice, it is removed and the agent must rewrite it. For advice on your situation, call Info-Santé at 811. In an emergency, call 911.",
          ],
        },
        {
          heading: "How it works",
          paragraphs: [
            "The agents run on CloudRaker Run. A welcome agent understands your question and passes it to a specialized agent (respiratory viruses, vaccination, seniors, mental health and others). Each agent exists in French and in English.",
            "Before your message goes to the agents, Decision-machine-1, a CloudRaker model hosted in Montréal, checks that it contains no personal information. It also checks that the reply contains no personal medical advice.",
          ],
        },
        {
          heading: "Open data we use",
          paragraphs: [
            "Postal code positions: \"CP Territoires\", Institut de la statistique du Québec (May 2026), under the Creative Commons Attribution 4.0 licence (CC BY 4.0).",
            "Places: the health and social services resources directory of the Gouvernement du Québec (sante.gouv.qc.ca). Each place links to its official page.",
            "Appointments: Agent Santé only gives a link to the Clic Santé results page. It does not read the available times and books no appointment.",
            "Map: Apple Maps (MapKit JS).",
          ],
          links: [
            { label: "CP Territoires (Données Québec)", href: "https://www.donneesquebec.ca/recherche/dataset/1a6267da-82ed-4ea0-b35d-9e9618a58ce7" },
            { label: "CC BY 4.0 licence", href: "https://creativecommons.org/licenses/by/4.0/" },
            { label: "Resources directory", href: "https://sante.gouv.qc.ca/en/repertoire-ressources/" },
          ],
        },
        {
          heading: "An open, volunteer project",
          paragraphs: [
            "CloudRaker built Agent Santé as a volunteer project. The site code and the agent instructions are public, under the Apache 2.0 license: anyone can read and check them.",
            "Agent Santé is not a service of the Gouvernement du Québec or of Santé Québec, and has no link with them.",
          ],
          links: [
            { label: "Site code on GitHub", href: LINKS.webRepo },
            { label: "Agent instructions on GitHub", href: LINKS.agentsRepo },
            { label: "CloudRaker", href: LINKS.cloudraker },
          ],
        },
      ],
    },
    privacy: {
      title: "Privacy policy",
      lead: "Agent Santé is built to keep as little data as possible, for as short a time as possible. Here is what happens to your messages.",
      updated: "October 25, 2026",
      sections: [
        {
          heading: "In short",
          paragraphs: [],
          list: [
            "No account, no upload, no tracking or analytics cookies.",
            "The conversation stays in the memory of this window. If you reload or close it, it ends.",
            "Your messages are deleted about 10 minutes after the conversation ends.",
            "Messages that contain personal information are blocked before they reach the language models.",
          ],
        },
        {
          heading: "Where your messages go",
          paragraphs: [
            "1. Your browser sends the message to the Agent Santé server, hosted by Cloudflare.",
            "2. The server first replaces a postal code with its area (see below). It then looks for numbers, emails and dates of birth. Next, Decision-machine-1, a CloudRaker model hosted in Montréal, looks for other personal information, such as a name or an address. If personal information is found, the message is blocked.",
            "3. If the message passes the filter, it goes to the CloudRaker Run agents. The language models run on servers in Canada and the United States, and can read the text of your messages.",
            "4. Decision-machine-1 checks the agent reply before it shows, to remove any personal medical advice.",
            "A voice message takes one more step first: your browser sends the recording to our server, which has rakeaudio, the CloudRaker transcription model, transcribe it in Montréal. The text comes back to your browser, then follows steps 1 to 4 like a typed message. If the filter blocks it, the text goes back to the message box so that you can correct it.",
          ],
        },
        {
          heading: "Your postal code",
          paragraphs: [
            "The postal code is the only personal information we accept, and only to find a service or an appointment near you. Give it only if you want to.",
            "Our server takes the postal code out of your message before any other step. The filter and the AI model see only your area (the first 3 characters, for example H2X), and the name of your municipality and of your CLSC territory.",
            "The server finds the position of the code in the open data of the Institut de la statistique du Québec. It does not keep the code: it keeps only this position and your area during your conversation, then it deletes them (at most 15 minutes after your last message).",
            "To look for places, the server sends a position rounded to about 100 m to the health resources directory. The Clic Santé link uses the same rounded position, never your postal code. The map (Apple Maps) gets only the positions of the places.",
            "Agent Santé never books an appointment for you. You book on Clic Santé yourself.",
          ],
        },
        {
          heading: "How long",
          paragraphs: [
            "Your session lasts 10 minutes after your last message. The conversation ends when you select End, when you close or reload the tab, or after 10 minutes with no activity. It is then cancelled at CloudRaker Run. Your messages are deleted about 10 minutes after the conversation ends.",
            "The Agent Santé server does not keep the text of your messages. Its logs contain only request numbers, status codes and durations, never the content.",
          ],
        },
        {
          heading: "Voice messages, recap and statistics",
          paragraphs: [
            "The microphone button records a voice message. Your browser asks for permission to use the microphone the first time you select it, never before. A recording lasts one minute at most.",
            "The sound goes only to our server, then to rakeaudio, the CloudRaker transcription model, in Montréal. Neither our server nor rakeaudio keeps the sound or the text. Our logs contain only the size, the length and the processing time. The sound never goes to the language models: only the transcribed text goes on, and it goes through the personal information filter like a typed message.",
            "The Transparency and Costs pages show totals only, such as the number of blocked messages. No text is kept there.",
            "PDF recap: only if you ask for it, the agent writes a summary of the conversation, checked like its other replies. Our server has it laid out by markdowntopdf.dev, a CloudRaker service that keeps nothing, then the PDF goes only to your browser. It is saved nowhere else.",
          ],
        },
        {
          heading: "Protection against robots and abuse",
          paragraphs: [
            "A Cloudflare check confirms that you are not a robot before the conversation. Your IP address is used to limit the number of requests, to protect the service. Agent Santé does not keep it.",
          ],
        },
        {
          heading: "Your choices",
          paragraphs: [
            "Your browser keeps only your language and display preferences, for your next visits. You can delete them in its settings.",
            "For a question about this policy, write to us on GitHub.",
          ],
          links: [{ label: "Open an issue on GitHub", href: `${LINKS.webRepo}/issues` }],
        },
      ],
    },
    terms: {
      title: "Terms of use",
      lead: "When you use Agent Santé, you accept these terms.",
      updated: "October 23, 2026",
      sections: [
        {
          heading: "Not an emergency service",
          paragraphs: [
            "Agent Santé is not an emergency service. In an emergency, call 911. To talk to a nurse, call Info-Santé at 811. For a psychosocial need, call Info-Social at 811, option 2. For a poisoning, call the Centre antipoison du Québec at 1 800 463-5060.",
          ],
        },
        {
          heading: "Not a government service",
          paragraphs: [
            "Agent Santé is a volunteer project by CloudRaker. It has no link with the Gouvernement du Québec, the Ministère de la Santé et des Services sociaux or Santé Québec. The cited sources belong to their authors.",
          ],
        },
        {
          heading: "General information only",
          paragraphs: [
            "Agent Santé gives general information from official sources and directs you to services. It does not give medical advice, does not make a diagnosis and does not replace a health professional. The answers are made automatically and can contain errors: always check the official source.",
          ],
        },
        {
          heading: "No liability",
          paragraphs: [
            "CloudRaker provides Agent Santé as is, with no warranty. CloudRaker takes no liability for a decision made from the answers, or for an interruption of the service.",
          ],
        },
        {
          heading: "Fair use",
          paragraphs: [
            "Do not write personal information. Do not use the service for abuse, automated sending or to get around its checks. The service can block a message or end a conversation.",
          ],
        },
        {
          heading: "Open source",
          paragraphs: ["The Agent Santé code is published under the Apache 2.0 license."],
          links: [{ label: "Site code on GitHub", href: LINKS.webRepo }],
        },
      ],
    },
  },
};
