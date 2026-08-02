/**
 * Templates das sequências automáticas de email.
 *
 * - `onboarding`: cadastrou (email verificado) e ainda não assinou → 7 emails
 *   em 14 dias empurrando pra primeira assinatura. Gatilho: `user.createdAt`.
 * - `post_subscription`: assinatura ativada → 2 emails de ativação.
 *   Gatilho: `subscription.createdAt`.
 *
 * Cada email tem conteúdo em pt-BR, en e es — o cron escolhe pela
 * `resolveEmailLocale(user.locale)` (prefixo pt→pt-BR, es→es, resto→en).
 *
 * Corpo em Markdown — passa pelo mesmo pipeline dos broadcasts do admin
 * (renderMarkdownToEmailHtml + wrapInBroadcastTemplate + merge tags
 * {{firstName}}, {{name}}, {{plan}}).
 *
 * Assuntos evitam termos que elevam score de spam ("+18", "sem censura",
 * nomes de plataformas adultas) — a reputação do domínio no Resend é a mesma
 * dos emails transacionais. Vale pros três idiomas.
 */

export type SequenceName = 'onboarding' | 'post_subscription';

export type EmailLocale = 'pt-BR' | 'en' | 'es';

export const EMAIL_LOCALES: EmailLocale[] = ['pt-BR', 'en', 'es'];

export interface LocalizedEmailContent {
  subject: string;
  body: (appUrl: string) => string;
}

export interface SequenceEmail {
  /** Identificador gravado em email_sequence_logs.email_key (imutável). */
  key: string;
  sequence: SequenceName;
  /** Dias após o evento-gatilho em que o email deve sair. */
  offsetDays: number;
  content: Record<EmailLocale, LocalizedEmailContent>;
}

/**
 * Mapeia o `user.locale` livre do banco (pt-BR, pt-PT, en-US, en-GB, es-ES,
 * de-DE, fr-FR...) pra um dos idiomas de email. Fallback: inglês.
 */
export function resolveEmailLocale(userLocale: string | null | undefined): EmailLocale {
  const l = (userLocale ?? '').trim().toLowerCase();
  if (l.startsWith('pt')) return 'pt-BR';
  if (l.startsWith('es')) return 'es';
  return 'en';
}

export const ONBOARDING_EMAILS: SequenceEmail[] = [
  {
    key: 'onboarding_1_welcome',
    sequence: 'onboarding',
    offsetDays: 0,
    content: {
      'pt-BR': {
        subject: 'Sua conta está pronta, {{firstName}} — veja o que dá pra criar',
        body: (appUrl) => `Oi {{firstName}}, bem-vindo à AI Model Lab 👋

Sua conta está ativa. A partir de agora você tem acesso à esteira completa pra criar modelos de IA hiper-realistas — com o mesmo rosto em toda geração, foto e vídeo, do lifestyle ao conteúdo exclusivo.

O que você consegue fazer aqui dentro:

- **Criar sua influencer** — rosto, corpo e estilo próprios, consistentes em cada imagem
- **Fotos Full HD e vídeos ultra realistas** — prontos pra feed, packs e assinantes
- **Motion Control e voz** — sua modelo se move e fala como uma pessoa real

O primeiro passo leva menos de 2 minutos: escolha um plano, entre no workspace e gere a primeira foto da sua modelo.

[Criar minha primeira modelo →](${appUrl}/checkout)

Qualquer dúvida, é só responder este email — a gente lê tudo.

— Equipe AI Model Lab`,
      },
      en: {
        subject: "Your account is ready, {{firstName}} — here's what you can create",
        body: (appUrl) => `Hi {{firstName}}, welcome to AI Model Lab 👋

Your account is live. You now have access to the full pipeline for creating hyper-realistic AI models — with the same face in every generation, photo and video, from lifestyle shots to exclusive content.

Here's what you can do inside:

- **Create your influencer** — her own face, body and style, consistent in every image
- **Full HD photos and ultra-realistic videos** — ready for your feed, packs and subscribers
- **Motion Control and voice** — your model moves and talks like a real person

The first step takes less than 2 minutes: pick a plan, open the workspace and generate your model's first photo.

[Create my first model →](${appUrl}/checkout)

Questions? Just reply to this email — we read everything.

— The AI Model Lab team`,
      },
      es: {
        subject: 'Tu cuenta está lista, {{firstName}} — mira lo que puedes crear',
        body: (appUrl) => `Hola {{firstName}}, bienvenido a AI Model Lab 👋

Tu cuenta está activa. Desde ahora tienes acceso al pipeline completo para crear modelos de IA hiperrealistas — con el mismo rostro en cada generación, foto y video, del lifestyle al contenido exclusivo.

Lo que puedes hacer aquí dentro:

- **Crear tu influencer** — rostro, cuerpo y estilo propios, consistentes en cada imagen
- **Fotos Full HD y videos ultrarrealistas** — listos para tu feed, packs y suscriptores
- **Motion Control y voz** — tu modelo se mueve y habla como una persona real

El primer paso toma menos de 2 minutos: elige un plan, entra al workspace y genera la primera foto de tu modelo.

[Crear mi primera modelo →](${appUrl}/checkout)

¿Dudas? Responde este email — leemos todo.

— Equipo AI Model Lab`,
      },
    },
  },
  {
    key: 'onboarding_2_quickwin',
    sequence: 'onboarding',
    offsetDays: 1,
    content: {
      'pt-BR': {
        subject: 'O passo a passo da sua primeira modelo (2 minutos)',
        body: (appUrl) => `{{firstName}}, ontem você criou sua conta. Hoje eu quero te mostrar como é simples sair do zero:

**1. Crie a persona** — escolha um rosto da galeria ou gere um do zero. Defina corpo, estilo e vibe em poucos cliques.

**2. Gere o conteúdo** — escolha cenário, pose e roupa. Se não quiser escrever prompt, usa um pronto da nossa [biblioteca de prompts](${appUrl}/prompts).

**3. Baixe e publique** — Full HD, sem marca d'água, pronto pra qualquer plataforma.

Não precisa de experiência com IA, edição ou design. A plataforma faz o trabalho pesado.

O plano Creator ($19,90/mês) te dá 12.000 créditos — dá pra gerar **mais de 130 fotos por mês**, ou misturar fotos e vídeos.

[Quero minha modelo pronta hoje →](${appUrl}/checkout)

— Equipe AI Model Lab`,
      },
      en: {
        subject: 'Your first model, step by step (2 minutes)',
        body: (appUrl) => `{{firstName}}, yesterday you created your account. Today I want to show you how simple it is to start from zero:

**1. Create the persona** — pick a face from the gallery or generate one from scratch. Set body, style and vibe in a few clicks.

**2. Generate the content** — choose the scene, pose and outfit. Don't want to write prompts? Use a ready-made one from our [prompt library](${appUrl}/prompts).

**3. Download and publish** — Full HD, no watermark, ready for any platform.

No experience with AI, editing or design required. The platform does the heavy lifting.

The Creator plan ($19.90/mo) gives you 12,000 credits — enough for **over 130 photos a month**, or a mix of photos and videos.

[I want my model ready today →](${appUrl}/checkout)

— The AI Model Lab team`,
      },
      es: {
        subject: 'Tu primera modelo, paso a paso (2 minutos)',
        body: (appUrl) => `{{firstName}}, ayer creaste tu cuenta. Hoy quiero mostrarte lo simple que es empezar desde cero:

**1. Crea la persona** — elige un rostro de la galería o genera uno desde cero. Define cuerpo, estilo y vibra en pocos clics.

**2. Genera el contenido** — elige escenario, pose y ropa. Si no quieres escribir prompts, usa uno listo de nuestra [biblioteca de prompts](${appUrl}/prompts).

**3. Descarga y publica** — Full HD, sin marca de agua, listo para cualquier plataforma.

No necesitas experiencia con IA, edición ni diseño. La plataforma hace el trabajo pesado.

El plan Creator ($19.90/mes) te da 12,000 créditos — alcanza para **más de 130 fotos al mes**, o una mezcla de fotos y videos.

[Quiero mi modelo lista hoy →](${appUrl}/checkout)

— Equipo AI Model Lab`,
      },
    },
  },
  {
    key: 'onboarding_3_mechanism',
    sequence: 'onboarding',
    offsetDays: 3,
    content: {
      'pt-BR': {
        subject: 'Por que a maioria das "modelos de IA" não segura assinante',
        body: (appUrl) => `{{firstName}}, deixa eu te contar o erro nº 1 de quem tenta criar uma modelo de IA por conta própria:

**o rosto muda a cada geração.**

Numa foto a modelo é uma, na outra é "quase ela". O assinante percebe em segundos — e assinante que percebe, cancela. Consistência de rosto não é detalhe estético: é o que segura receita recorrente em plataforma de assinatura.

É exatamente isso que a AI Model Lab resolve. Nossa engine mantém o **mesmo rosto em cada foto e cada vídeo** — inclusive no conteúdo mais ousado, onde as outras ferramentas travam ou censuram.

Uma persona. Um rosto. Conteúdo infinito.

[Ver a consistência na prática →](${appUrl}/checkout)

— Equipe AI Model Lab`,
      },
      en: {
        subject: `Why most "AI models" can't keep subscribers`,
        body: (appUrl) => `{{firstName}}, let me tell you the #1 mistake people make when they try to build an AI model on their own:

**the face changes with every generation.**

In one photo it's her, in the next it's "almost her". Subscribers notice in seconds — and subscribers who notice, cancel. Face consistency isn't a cosmetic detail: it's what keeps recurring revenue alive on subscription platforms.

That's exactly what AI Model Lab solves. Our engine keeps the **same face in every photo and every video** — including the boldest content, where other tools choke or censor.

One persona. One face. Infinite content.

[See the consistency in action →](${appUrl}/checkout)

— The AI Model Lab team`,
      },
      es: {
        subject: 'Por qué la mayoría de las "modelos de IA" no retienen suscriptores',
        body: (appUrl) => `{{firstName}}, déjame contarte el error #1 de quien intenta crear una modelo de IA por su cuenta:

**el rostro cambia en cada generación.**

En una foto es ella, en la otra es "casi ella". El suscriptor lo nota en segundos — y el suscriptor que lo nota, cancela. La consistencia del rostro no es un detalle estético: es lo que sostiene el ingreso recurrente en plataformas de suscripción.

Eso es exactamente lo que AI Model Lab resuelve. Nuestro engine mantiene el **mismo rostro en cada foto y cada video** — incluso en el contenido más atrevido, donde otras herramientas fallan o censuran.

Una persona. Un rostro. Contenido infinito.

[Ver la consistencia en acción →](${appUrl}/checkout)

— Equipo AI Model Lab`,
      },
    },
  },
  {
    key: 'onboarding_4_usecase',
    sequence: 'onboarding',
    offsetDays: 5,
    content: {
      'pt-BR': {
        subject: 'Como abastecer 3 plataformas com uma modelo só',
        body: (appUrl) => `{{firstName}}, quem opera modelo de IA de verdade não gera "uma foto bonita". Opera uma **esteira**:

- **Feed** — fotos lifestyle diárias pra atrair e converter seguidor
- **Packs** — conjuntos temáticos em Full HD pro conteúdo pago
- **Vídeos** — a modelo se movendo e falando, o formato que mais converte
- **Bot no Telegram** — conteúdo exclusivo em escala, no automático

Tudo isso com a mesma persona, o mesmo rosto, sem fotógrafo, sem equipe e sem depender de modelo real.

No plano Creator, 12.000 créditos/mês sustentam essa esteira: por exemplo, **~100 fotos + 5 vídeos por mês** — conteúdo novo todo dia, por menos de $0,70/dia.

[Montar minha esteira →](${appUrl}/checkout)

— Equipe AI Model Lab`,
      },
      en: {
        subject: 'How to feed 3 platforms with a single model',
        body: (appUrl) => `{{firstName}}, people who run AI models for real don't generate "one pretty picture". They run a **pipeline**:

- **Feed** — daily lifestyle photos to attract and convert followers
- **Packs** — themed Full HD sets for paid content
- **Videos** — your model moving and talking, the highest-converting format
- **Telegram bot** — exclusive content at scale, on autopilot

All of it with the same persona, the same face — no photographer, no team, no dependence on a real model.

On the Creator plan, 12,000 credits/month sustain that pipeline: for example, **~100 photos + 5 videos per month** — fresh content every day for under $0.70/day.

[Build my pipeline →](${appUrl}/checkout)

— The AI Model Lab team`,
      },
      es: {
        subject: 'Cómo abastecer 3 plataformas con una sola modelo',
        body: (appUrl) => `{{firstName}}, quien opera modelos de IA en serio no genera "una foto bonita". Opera un **pipeline**:

- **Feed** — fotos lifestyle diarias para atraer y convertir seguidores
- **Packs** — sets temáticos en Full HD para el contenido de pago
- **Videos** — tu modelo moviéndose y hablando, el formato que más convierte
- **Bot de Telegram** — contenido exclusivo a escala, en automático

Todo con la misma persona, el mismo rostro, sin fotógrafo, sin equipo y sin depender de una modelo real.

En el plan Creator, 12,000 créditos/mes sostienen ese pipeline: por ejemplo, **~100 fotos + 5 videos al mes** — contenido nuevo cada día por menos de $0.70/día.

[Armar mi pipeline →](${appUrl}/checkout)

— Equipo AI Model Lab`,
      },
    },
  },
  {
    key: 'onboarding_5_objections',
    sequence: 'onboarding',
    offsetDays: 7,
    content: {
      'pt-BR': {
        subject: '"Mas eu não entendo nada de IA..."',
        body: (appUrl) => `{{firstName}}, uma semana atrás você criou sua conta e ainda não gerou sua primeira modelo. Normalmente é por um destes 3 motivos:

**"Não entendo nada de IA."**
Não precisa. Tem galeria de rostos prontos, prompts prontos e fluxo guiado. Se você sabe usar Instagram, sabe usar a AI Model Lab.

**"IA tem cara de IA."**
Por isso existe o **Skin Enhancer**: um clique e a imagem ganha poros e textura de pele natural. O resultado passa em qualquer feed.

**"Vou pagar e não usar."**
Sem fidelidade — cancela quando quiser, direto na plataforma. E os créditos renovam todo mês: se você usar 20 minutos por dia, já produz mais conteúdo que a maioria das operações.

[Testar sem risco →](${appUrl}/checkout)

— Equipe AI Model Lab`,
      },
      en: {
        subject: `"But I don't know anything about AI..."`,
        body: (appUrl) => `{{firstName}}, a week ago you created your account and you still haven't generated your first model. It's usually one of these 3 reasons:

**"I don't know anything about AI."**
You don't need to. There's a gallery of ready-made faces, ready-made prompts and a guided flow. If you can use Instagram, you can use AI Model Lab.

**"AI content looks like AI."**
That's why the **Skin Enhancer** exists: one click and the image gets natural pores and skin texture. The result passes on any feed.

**"I'll pay and never use it."**
No lock-in — cancel anytime, right from the platform. And credits renew every month: 20 minutes a day already puts out more content than most operations.

[Try it risk-free →](${appUrl}/checkout)

— The AI Model Lab team`,
      },
      es: {
        subject: '"Pero yo no sé nada de IA..."',
        body: (appUrl) => `{{firstName}}, hace una semana creaste tu cuenta y todavía no generaste tu primera modelo. Normalmente es por una de estas 3 razones:

**"No sé nada de IA."**
No hace falta. Hay galería de rostros listos, prompts listos y un flujo guiado. Si sabes usar Instagram, sabes usar AI Model Lab.

**"La IA se nota que es IA."**
Para eso existe el **Skin Enhancer**: un clic y la imagen gana poros y textura de piel natural. El resultado pasa en cualquier feed.

**"Voy a pagar y no usarlo."**
Sin permanencia — cancela cuando quieras, directo en la plataforma. Y los créditos se renuevan cada mes: con 20 minutos al día ya produces más contenido que la mayoría de las operaciones.

[Probar sin riesgo →](${appUrl}/checkout)

— Equipo AI Model Lab`,
      },
    },
  },
  {
    key: 'onboarding_6_cost_anchor',
    sequence: 'onboarding',
    offsetDays: 10,
    content: {
      'pt-BR': {
        subject: 'O custo real de produzir conteúdo (comparação honesta)',
        body: (appUrl) => `{{firstName}}, faz a conta comigo. Produzir conteúdo com modelo real:

- Cachê da modelo: R$500–2.000 por ensaio
- Fotógrafo + edição: R$300–1.000
- Resultado: **um** pack. Sem recorrência, com agenda, com dependência de terceiros.

Produzir com a AI Model Lab:

- $19,90/mês
- 130+ fotos ou uma esteira de fotos + vídeos
- A modelo nunca cancela, nunca atrasa, nunca sai do projeto
- E o rosto é **seu ativo** — ninguém pode levar embora

Não é sobre gastar menos. É sobre ter uma operação que **escala sem depender de ninguém**.

[Começar por $19,90/mês →](${appUrl}/checkout)

— Equipe AI Model Lab`,
      },
      en: {
        subject: 'The real cost of producing content (an honest comparison)',
        body: (appUrl) => `{{firstName}}, do the math with me. Producing content with a real model:

- Model's fee: $200–800 per shoot
- Photographer + editing: $150–500
- The result: **one** pack. No recurrence, scheduling headaches, dependence on other people.

Producing with AI Model Lab:

- $19.90/mo
- 130+ photos, or a pipeline of photos + videos
- Your model never cancels, never shows up late, never quits the project
- And the face is **your asset** — nobody can take it away

It's not about spending less. It's about running an operation that **scales without depending on anyone**.

[Start for $19.90/mo →](${appUrl}/checkout)

— The AI Model Lab team`,
      },
      es: {
        subject: 'El costo real de producir contenido (comparación honesta)',
        body: (appUrl) => `{{firstName}}, saca la cuenta conmigo. Producir contenido con una modelo real:

- Tarifa de la modelo: $200–800 por sesión
- Fotógrafo + edición: $150–500
- Resultado: **un** pack. Sin recurrencia, con agenda, dependiendo de terceros.

Producir con AI Model Lab:

- $19.90/mes
- 130+ fotos, o un pipeline de fotos + videos
- Tu modelo nunca cancela, nunca llega tarde, nunca abandona el proyecto
- Y el rostro es **tu activo** — nadie te lo puede quitar

No se trata de gastar menos. Se trata de tener una operación que **escala sin depender de nadie**.

[Empezar por $19.90/mes →](${appUrl}/checkout)

— Equipo AI Model Lab`,
      },
    },
  },
  {
    key: 'onboarding_7_close',
    sequence: 'onboarding',
    offsetDays: 14,
    content: {
      'pt-BR': {
        subject: '{{firstName}}, vou ser direto',
        body: (appUrl) => `{{firstName}}, esse é o último email desta série, então vou ser direto.

Você criou sua conta há 2 semanas. Nesse tempo, quem assinou no mesmo dia que você se cadastrou já produziu o primeiro mês inteiro de conteúdo — persona definida, feed abastecido, primeiros packs prontos.

A diferença entre vocês não é conhecimento, equipamento nem talento. É só ter dado o primeiro passo.

Se o momento não é agora, tudo bem — sua conta continua ativa e você pode voltar quando quiser. Mas se o que falta é só decidir:

[Criar minha modelo agora →](${appUrl}/checkout)

Foi um prazer. A partir daqui, você só recebe novidades importantes da plataforma (bem de vez em quando).

— Equipe AI Model Lab`,
      },
      en: {
        subject: "{{firstName}}, I'll be straight with you",
        body: (appUrl) => `{{firstName}}, this is the last email in this series, so I'll be straight with you.

You created your account 2 weeks ago. In that time, people who subscribed the same day you signed up have already produced their entire first month of content — persona defined, feed stocked, first packs ready.

The difference between you isn't knowledge, equipment or talent. It's just having taken the first step.

If now isn't the moment, that's fine — your account stays active and you can come back whenever. But if all that's missing is the decision:

[Create my model now →](${appUrl}/checkout)

It's been a pleasure. From here on, you'll only hear from us about important platform updates (very occasionally).

— The AI Model Lab team`,
      },
      es: {
        subject: '{{firstName}}, te lo digo directo',
        body: (appUrl) => `{{firstName}}, este es el último email de esta serie, así que te lo digo directo.

Creaste tu cuenta hace 2 semanas. En ese tiempo, quienes se suscribieron el mismo día que tú te registraste ya produjeron su primer mes completo de contenido — persona definida, feed abastecido, primeros packs listos.

La diferencia entre ustedes no es conocimiento, equipo ni talento. Es solo haber dado el primer paso.

Si ahora no es el momento, está bien — tu cuenta sigue activa y puedes volver cuando quieras. Pero si lo único que falta es decidir:

[Crear mi modelo ahora →](${appUrl}/checkout)

Fue un placer. A partir de aquí, solo recibirás novedades importantes de la plataforma (muy de vez en cuando).

— Equipo AI Model Lab`,
      },
    },
  },
];

export const POST_SUBSCRIPTION_EMAILS: SequenceEmail[] = [
  {
    key: 'postsub_1_activation',
    sequence: 'post_subscription',
    offsetDays: 0,
    content: {
      'pt-BR': {
        subject: 'Assinatura ativa ✅ — seus créditos já estão na conta',
        body: (appUrl) => `{{firstName}}, sua assinatura {{plan}} está ativa e seus créditos já estão disponíveis. 🎉

Faz assim agora (leva 2 minutos):

1. Entre no [workspace](${appUrl}/workspace)
2. Escolha um rosto da galeria (ou gere um novo)
3. Use um prompt pronto da [biblioteca](${appUrl}/prompts) e gere a primeira foto

Dica de quem já opera: **defina a persona antes de sair gerando.** Nome, vibe, estilo, tipo de conteúdo. Modelo com identidade clara segura muito mais assinante do que foto bonita solta.

[Gerar minha primeira foto →](${appUrl}/workspace)

— Equipe AI Model Lab`,
      },
      en: {
        subject: 'Subscription active ✅ — your credits are in',
        body: (appUrl) => `{{firstName}}, your {{plan}} subscription is active and your credits are ready to use. 🎉

Do this now (takes 2 minutes):

1. Open the [workspace](${appUrl}/workspace)
2. Pick a face from the gallery (or generate a new one)
3. Grab a ready-made prompt from the [library](${appUrl}/prompts) and generate your first photo

A tip from people who already run this: **define the persona before you start generating.** Name, vibe, style, type of content. A model with a clear identity keeps far more subscribers than a random pretty picture.

[Generate my first photo →](${appUrl}/workspace)

— The AI Model Lab team`,
      },
      es: {
        subject: 'Suscripción activa ✅ — tus créditos ya están en tu cuenta',
        body: (appUrl) => `{{firstName}}, tu suscripción {{plan}} está activa y tus créditos ya están disponibles. 🎉

Haz esto ahora (toma 2 minutos):

1. Entra al [workspace](${appUrl}/workspace)
2. Elige un rostro de la galería (o genera uno nuevo)
3. Usa un prompt listo de la [biblioteca](${appUrl}/prompts) y genera la primera foto

Consejo de quien ya opera: **define la persona antes de ponerte a generar.** Nombre, vibra, estilo, tipo de contenido. Una modelo con identidad clara retiene muchos más suscriptores que una foto bonita suelta.

[Generar mi primera foto →](${appUrl}/workspace)

— Equipo AI Model Lab`,
      },
    },
  },
  {
    key: 'postsub_2_credits_guide',
    sequence: 'post_subscription',
    offsetDays: 2,
    content: {
      'pt-BR': {
        subject: 'Como render o máximo dos seus créditos',
        body: (appUrl) => `{{firstName}}, seus créditos renovam todo mês (e não acumulam) — então o jogo é produzir em ritmo. Referência rápida de custo:

- Foto Full HD: **90 créditos**
- Foto 2K: **130 créditos**
- Vídeo 8s: **a partir de 600 créditos**

**Plano de produção da semana 1:**

- Dias 1–2: gere 10–15 variações do rosto até travar a persona definitiva
- Dias 3–4: primeiro lote de fotos lifestyle (feed) + aplique o Skin Enhancer
- Dias 5–7: primeiro pack temático + 1 vídeo de apresentação da modelo

Seguindo isso, no domingo você tem feed abastecido e o primeiro conteúdo pago pronto pra vender.

[Continuar produção →](${appUrl}/workspace)

— Equipe AI Model Lab`,
      },
      en: {
        subject: 'How to get the most out of your credits',
        body: (appUrl) => `{{firstName}}, your credits renew every month (and don't roll over) — so the game is producing at a steady pace. Quick cost reference:

- Full HD photo: **90 credits**
- 2K photo: **130 credits**
- 8s video: **from 600 credits**

**Week 1 production plan:**

- Days 1–2: generate 10–15 face variations until you lock the final persona
- Days 3–4: first batch of lifestyle photos (feed) + apply the Skin Enhancer
- Days 5–7: first themed pack + 1 intro video of your model

Follow that and by Sunday you'll have a stocked feed and your first paid content ready to sell.

[Keep producing →](${appUrl}/workspace)

— The AI Model Lab team`,
      },
      es: {
        subject: 'Cómo aprovechar al máximo tus créditos',
        body: (appUrl) => `{{firstName}}, tus créditos se renuevan cada mes (y no se acumulan) — así que el juego es producir con ritmo. Referencia rápida de costos:

- Foto Full HD: **90 créditos**
- Foto 2K: **130 créditos**
- Video de 8s: **desde 600 créditos**

**Plan de producción de la semana 1:**

- Días 1–2: genera 10–15 variaciones del rostro hasta fijar la persona definitiva
- Días 3–4: primer lote de fotos lifestyle (feed) + aplica el Skin Enhancer
- Días 5–7: primer pack temático + 1 video de presentación de tu modelo

Siguiendo eso, el domingo tienes el feed abastecido y el primer contenido de pago listo para vender.

[Seguir produciendo →](${appUrl}/workspace)

— Equipo AI Model Lab`,
      },
    },
  },
];

/**
 * Decide qual email da sequência enviar pra um usuário hoje.
 *
 * Regras:
 * - Só emails cujo dia já chegou (`offsetDays <= daysSinceTrigger`);
 * - Janela de catch-up: se o dia do email já passou há mais de `catchupDays`,
 *   ele expira e nunca é enviado (impede rajada retroativa pra usuários antigos
 *   e pile-up se o cron ficar fora do ar);
 * - No máximo UM email por execução: o mais avançado ainda elegível.
 */
export function pickNextSequenceEmail(
  emails: SequenceEmail[],
  daysSinceTrigger: number,
  sentKeys: ReadonlySet<string>,
  catchupDays: number,
): SequenceEmail | null {
  let candidate: SequenceEmail | null = null;
  for (const email of emails) {
    if (sentKeys.has(email.key)) continue;
    const due = email.offsetDays <= daysSinceTrigger;
    const expired = daysSinceTrigger > email.offsetDays + catchupDays;
    if (due && !expired && (!candidate || email.offsetDays > candidate.offsetDays)) {
      candidate = email;
    }
  }
  return candidate;
}
