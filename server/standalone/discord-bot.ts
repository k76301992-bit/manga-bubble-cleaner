import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits,
  MessageFlags, SlashCommandBuilder, type Attachment, type ButtonInteraction, type ChatInputCommandInteraction,
  type Message, type TextChannel,
} from "discord.js";
import { type CleaningQuality } from "./cleaner";
import { cleanBatchInMemory, createResultZip, extractImagesFromZip, MAX_IMAGES_PER_BATCH, MAX_ZIP_BYTES, mimeTypeForFileName, type BatchImage } from "./batch-processing";
import { createGoogleDriveResultFolder, readGoogleDriveSource } from "./google-drive";

const V2_FLAG = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;
const STATUS_HEARTBEAT_MS = 20_000;
const SOURCE_TIMEOUT_MS = 5 * 60_000;
const MAX_DISCORD_RESULT_BYTES = 24 * 1024 * 1024;
const GOLD = 0xD5AA55;
const RED = 0xD94A4A;
const cleanCommand = new SlashCommandBuilder().setName("clean").setDescription("ابدأ تبييض فصل مانهوا أو صفحة واحدة");
const helpCommand = new SlashCommandBuilder().setName("help").setDescription("تعليمات استخدام Manga Bubble Cleaner");

type DiscordAttachmentInput = Pick<Attachment, "url" | "name" | "size" | "contentType">;
type SourceKind = "discord-images" | "zip" | "drive";
type SourceBatch = { kind: SourceKind; sourceName: string; images: BatchImage[] };
type V2Component = Record<string, unknown>;
type ModeSession = { id: string; userId: string; channelId: string; createdAt: number };
const modeSessions = new Map<string, ModeSession>();

function isDiscordCdn(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && new Set(["cdn.discordapp.com", "media.discordapp.net"]).has(url.hostname.toLowerCase());
  } catch { return false; }
}

function mimeTypeForAttachment(attachment: DiscordAttachmentInput) {
  const declared = attachment.contentType?.split(";")[0].toLowerCase();
  return declared && ["image/png", "image/jpeg", "image/webp"].includes(declared) ? declared : mimeTypeForFileName(attachment.name);
}

export function validateDiscordImageAttachment(attachment: DiscordAttachmentInput) {
  if (!isDiscordCdn(attachment.url)) return "يجب أن يكون الملف مرفقًا من Discord نفسه عبر HTTPS.";
  if (!mimeTypeForAttachment(attachment)) return "ارفع صور PNG أو JPG أو WebP فقط.";
  if (!attachment.size || attachment.size > 20 * 1024 * 1024) return "يجب ألا تتجاوز الصورة 20 ميغابايت.";
  return undefined;
}

function validateDiscordZipAttachment(attachment: DiscordAttachmentInput) {
  if (!isDiscordCdn(attachment.url)) return "يجب أن يكون ملف ZIP مرفقًا من Discord نفسه عبر HTTPS.";
  if (!attachment.name.toLowerCase().endsWith(".zip")) return "ارفع ملف ZIP يحتوي صور PNG أو JPG أو WebP.";
  if (!attachment.size || attachment.size > MAX_ZIP_BYTES) return "يجب ألا يتجاوز ملف ZIP 25 ميغابايت.";
  return undefined;
}

function duration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}د ${total % 60}ث` : `${total}ث`;
}

function qualityLabel(quality: CleaningQuality) {
  return quality === "maximum-detail" ? "دقة كاملة" : "سرعة عالية";
}

function panel(sections: string[], options: { error?: boolean; files?: string[] } = {}): V2Component[] {
  const children: V2Component[] = [];
  sections.filter(Boolean).forEach((section, index) => {
    if (index) children.push({ type: 14, divider: true, spacing: 1 });
    children.push({ type: 10, content: section });
  });
  for (const name of options.files ?? []) {
    children.push({ type: 14, divider: true, spacing: 1 });
    children.push({ type: 13, file: { url: `attachment://${name}` } });
  }
  return [{ type: 17, accent_color: options.error ? RED : GOLD, components: children }];
}

function componentsOptions(components: V2Component[], extra: Record<string, unknown> = {}) {
  return { ...extra, components: components as never, flags: V2_FLAG } as never;
}

async function sendPanel(channel: TextChannel, sections: string[], options: { error?: boolean; files?: string[]; attachments?: AttachmentBuilder[] } = {}) {
  return channel.send(componentsOptions(panel(sections, options), options.attachments?.length ? { files: options.attachments } : {}));
}

function modeSections() {
  return [
    "## ⚙️ اختر وضع التبييض",
    "### ⚡ سرعة عالية — موصى به\nيكشف الفقاعات البيضاء والرمادية محليًا وبشكل محافظ؛ لا ينتظر خدمة كشف خارجية، لذلك يناسب الفصول المعتادة.",
    "### ✅ دقة كاملة\nيضيف كشفًا خارجيًا للفقاعات الصعبة والملونة عند الحاجة، ثم يرمم مناطق النص بقناع عبر نموذج Anime-Manga Big-LaMa المقيم. إذا تعذر الكشف في شريحة، يكمل البوت الصفحة من دون إيقاف الدفعة.",
  ];
}

function sourceSections() {
  return [
    "## 📂 خطوة إرفاق صور الفصل",
    "## توجد ثلاث طرق لإرسال صور فصلك.",
    `📷 **الطريقة الأولى:** أرفق حتى **${MAX_IMAGES_PER_BATCH}** صور مباشرة في رسالة واحدة، واحفظ ترتيب الصفحات في أسمائها.`,
    "🗜️ **الطريقة الثانية:** أرسل ملف ZIP واحدًا يحتوي صور الفصل مرتبة بأسمائها؛ سيعود ZIP بالنتائج.",
    "🗂️ **الطريقة الثالثة:** أرسل رابط Google Drive لصورة أو ZIP أو مجلد مشترك مع حساب الخدمة؛ سيُنشأ مجلد نتائج جديد ويُعاد رابطه.",
  ];
}

function statusSections(stage: string, detail: string, current?: number, total?: number, heartbeat = 0) {
  const progress = current !== undefined && total ? `**${current}/${total}**` : "`...`";
  const pulse = "·".repeat((heartbeat % 3) + 1);
  return [
    `⏳ **الحالة:** ${stage}`,
    `📊 **التقدم:** ${progress} ${pulse}`,
    `ℹ️ ${detail}`,
  ];
}

class CleaningStatus {
  private heartbeat = 0;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private stage: string;
  private detail: string;
  private current?: number;
  private total?: number;
  private constructor(private readonly message: Message, stage: string, detail: string, current?: number, total?: number) {
    this.stage = stage;
    this.detail = detail;
    this.current = current;
    this.total = total;
  }

  static async create(channel: TextChannel, stage: string, detail: string, current?: number, total?: number) {
    const message = await sendPanel(channel, statusSections(stage, detail, current, total));
    const status = new CleaningStatus(message, stage, detail, current, total);
    status.timer = setInterval(() => { void status.render(); }, STATUS_HEARTBEAT_MS);
    return status;
  }

  async update(stage: string, detail: string, options: { error?: boolean; current?: number; total?: number } = {}) {
    this.stage = stage;
    this.detail = detail;
    this.current = options.current;
    this.total = options.total;
    this.heartbeat += 1;
    await this.render(options.error);
  }

  private async render(error = false) {
    if (this.closed) return;
    this.heartbeat += 1;
    try { await this.message.edit({ components: panel(statusSections(this.stage, this.detail, this.current, this.total, this.heartbeat), { error }) as never } as never); }
    catch { this.closed = true; if (this.timer) clearInterval(this.timer); }
  }

  async close(deleteMessage = true) {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (deleteMessage) { try { await this.message.delete(); } catch { /* Message may have been removed by a moderator. */ } }
  }
}

function modeButtons(session: ModeSession) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mbc-mode:${session.id}:balanced`).setLabel("سرعة عالية").setEmoji("⚡").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mbc-mode:${session.id}:maximum-detail`).setLabel("دقة كاملة").setEmoji("✅").setStyle(ButtonStyle.Secondary),
  );
}

async function fetchAttachmentBytes(attachment: DiscordAttachmentInput) {
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error("تعذر تنزيل مرفق Discord المؤقت.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ZIP_BYTES) throw new Error("حجم الملف بعد التنزيل يتجاوز الحد الآمن.");
  return buffer;
}

export async function sourceFromDiscordAttachments(attachments: DiscordAttachmentInput[]): Promise<SourceBatch> {
  if (!attachments.length) throw new Error("لم ترسل أي مرفق.");
  const zipFiles = attachments.filter((attachment) => attachment.name.toLowerCase().endsWith(".zip"));
  if (zipFiles.length) {
    if (attachments.length !== 1) throw new Error("أرسل ZIP وحده، أو أرسل صورًا مباشرة فقط؛ لا تخلط بينهما.");
    const invalid = validateDiscordZipAttachment(zipFiles[0]);
    if (invalid) throw new Error(invalid);
    return { kind: "zip", sourceName: zipFiles[0].name.replace(/\.zip$/i, ""), images: await extractImagesFromZip(await fetchAttachmentBytes(zipFiles[0])) };
  }
  if (attachments.length > MAX_IMAGES_PER_BATCH) throw new Error(`الحد الأقصى هو ${MAX_IMAGES_PER_BATCH} صور في العملية الواحدة.`);
  const images: BatchImage[] = [];
  for (const attachment of attachments) {
    const invalid = validateDiscordImageAttachment(attachment);
    if (invalid) throw new Error(invalid);
    const mimeType = mimeTypeForAttachment(attachment);
    if (!mimeType) throw new Error("نوع الصورة غير مدعوم.");
    images.push({ name: attachment.name, mimeType, image: await fetchAttachmentBytes(attachment) });
  }
  return { kind: "discord-images", sourceName: "discord-pages", images };
}

async function awaitSourceMessage(channel: TextChannel, userId: string) {
  const messages = await channel.awaitMessages({ filter: (message) => message.author.id === userId && (message.attachments.size > 0 || /^https:\/\//i.test(message.content.trim())), max: 1, time: SOURCE_TIMEOUT_MS, errors: ["time"] });
  return messages.first()!;
}

async function sourceFromMessage(message: Message): Promise<SourceBatch> {
  if (message.attachments.size) return sourceFromDiscordAttachments([...message.attachments.values()]);
  const link = message.content.trim();
  const driveSource = await readGoogleDriveSource(link);
  return { ...driveSource, kind: "drive" };
}

async function sendFinalResult(channel: TextChannel, source: SourceBatch, results: Awaited<ReturnType<typeof cleanBatchInMemory>>, elapsed: number) {
  if (source.kind === "drive") {
    const folder = await createGoogleDriveResultFolder({ sourceName: source.sourceName, results });
    await sendPanel(channel, [
      "## ✅ تم تبييض الفصل بنجاح",
      `📷 تمت معالجة **${results.length}** صورة وحفظها داخل مجلد نتائج جديد في Google Drive.`,
      `📊 تقرير العملية: المدة **${duration(elapsed)}**، وضع التسليم **Google Drive**.`,
      `🔗 رابط المجلد: ${folder.url}`,
    ]);
    return;
  }
  if (source.kind === "zip") {
    const archive = await createResultZip(results);
    const fileName = `${source.sourceName}-cleaned.zip`;
    await sendPanel(channel, [
      "## ✅ تم تبييض الفصل بنجاح",
      `📷 تمت معالجة **${results.length}** صورة وإرفاق ملف **${fileName}**.`,
      `📊 تقرير العملية: المدة **${duration(elapsed)}**، وضع التسليم **ZIP**.`,
    ], { files: [fileName], attachments: [new AttachmentBuilder(archive, { name: fileName })] });
    return;
  }
  const totalBytes = results.reduce((total, result) => total + result.image.length, 0);
  if (totalBytes > MAX_DISCORD_RESULT_BYTES) throw new Error("نتائج الصور أكبر من حد الإرسال في Discord. استخدم ZIP أو Google Drive للفصل الكبير.");
  const attachments = results.map((result) => new AttachmentBuilder(result.image, { name: result.outputName }));
  await sendPanel(channel, [
    "## ✅ تم تبييض الفصل بنجاح",
    `📷 تمت معالجة **${results.length}** صورة وإرفاق كل نتيجة باسمها الأصلي مع لاحقة **-clean**.`,
    `📊 تقرير العملية: المدة **${duration(elapsed)}**، وضع التسليم **مرفقات Discord**.`,
  ], { files: results.map((result) => result.outputName), attachments });
}

async function runCleaningFlow(channel: TextChannel, userId: string, quality: CleaningQuality) {
  let status: CleaningStatus | undefined;
  const startedAt = Date.now();
  try {
    status = await CleaningStatus.create(channel, "جاري قراءة المصدر", "استلمت المصدر، وسأحدّث هذه اللوحة أثناء التحميل والتبييض.");
    const sourceMessage = await awaitSourceMessage(channel, userId);
    const source = await sourceFromMessage(sourceMessage);
    await status.update("بدأ التبييض الآن", `تم العثور على **${source.images.length}** صورة في المصدر.`, { current: 0, total: source.images.length });
    const results = await cleanBatchInMemory({
      images: source.images,
      quality,
      onProgress: async (current, total, name) => {
        const detail = current === total ? "اكتمل تبييض الصور؛ يجري تجهيز التسليم." : `تجري معالجة الصورة **${current + 1}** من **${total}**: **${name}**.`;
        await status?.update("التبييض مستمر", detail, { current, total });
      },
    });
    await status.update("تجهيز النتيجة", "اكتملت المعالجة؛ يجري رفع النتيجة إلى وجهتها.", { current: results.length, total: results.length });
    await status.close();
    status = undefined;
    await sendFinalResult(channel, source, results, (Date.now() - startedAt) / 1000);
  } catch (error) {
    const message = error instanceof Error ? error.message : "خطأ غير معروف.";
    if (status) await status.update("✖️ تعذرت العملية", message, { error: true });
    else await sendPanel(channel, ["## ✖️ تعذرت العملية", `ℹ️ ${message}`], { error: true });
  }
}

async function startWizard(channel: TextChannel, userId: string) {
  const session: ModeSession = { id: crypto.randomUUID().slice(0, 12), userId, channelId: channel.id, createdAt: Date.now() };
  modeSessions.set(session.id, session);
  await sendPanel(channel, modeSections());
  await channel.send({ content: "⚙️ **اختر وضع المعالجة من الأزرار بالأسفل:**", components: [modeButtons(session)] });
  setTimeout(() => modeSessions.delete(session.id), 15 * 60_000);
}

async function handleModeButton(interaction: ButtonInteraction) {
  const [, rawSessionId, rawQuality] = interaction.customId.split(":");
  const session = modeSessions.get(rawSessionId);
  if (!session || session.channelId !== interaction.channelId || Date.now() - session.createdAt > 15 * 60_000) {
    await interaction.reply({ content: "انتهى وقت هذه اللوحة. ابدأ `/clean` من جديد.", flags: EPHEMERAL });
    return;
  }
  if (session.userId !== interaction.user.id) {
    await interaction.reply({ content: "هذه اللوحة ليست لك. استخدم `/clean` لإنشاء لوحة خاصة بتدفقك.", flags: EPHEMERAL });
    return;
  }
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !interaction.inGuild()) {
    await interaction.reply({ content: "استخدم البوت داخل قناة نصية في خادم Discord.", flags: EPHEMERAL });
    return;
  }
  modeSessions.delete(session.id);
  const quality: CleaningQuality = rawQuality === "maximum-detail" ? "maximum-detail" : "balanced";
  await interaction.update({ content: `✅ تم اختيار **${qualityLabel(quality)}**. أرسل المصدر في القناة التالية.` , components: [] });
  await sendPanel(channel as TextChannel, sourceSections());
  void runCleaningFlow(channel as TextChannel, interaction.user.id, quality);
}

async function handleClean(interaction: ChatInputCommandInteraction) {
  if (!interaction.inGuild() || !interaction.channel?.isTextBased()) {
    await interaction.reply({ content: "استخدم `/clean` داخل قناة نصية في خادم Discord.", flags: EPHEMERAL });
    return;
  }
  await interaction.deferReply({ flags: EPHEMERAL });
  await startWizard(interaction.channel as TextChannel, interaction.user.id);
  await interaction.editReply("أرسلت لوحة بدء التبييض في هذه القناة.");
}

async function handleHelp(interaction: ChatInputCommandInteraction) {
  if (!interaction.inGuild() || !interaction.channel?.isTextBased()) {
    await interaction.reply({ content: "استخدم `/help` داخل قناة نصية في خادم Discord.", flags: EPHEMERAL });
    return;
  }
  await interaction.deferReply({ flags: EPHEMERAL });
  await sendPanel(interaction.channel as TextChannel, [
    "# 📷 Manga Bubble Cleaner",
    "بوت لتبييض نصوص فقاعات المانهوا مع الحفاظ على الرسم. استخدم `/clean` أو `!clean` للبدء.",
    "🎮 **طريقة العمل**\nاختر سرعة عالية أو دقة كاملة، ثم أرسل صورًا مباشرة أو ZIP أو رابط Google Drive داخل القناة نفسها.",
    "📦 **تسليم النتيجة**\nالمرفقات تعود صورًا، ZIP يعود ZIP، وGoogle Drive يعود برابط مجلد نتائج جديد. لا يحفظ الخادم الصور على قرصه.",
  ]);
  await interaction.editReply("أرسلت لوحة التعليمات في القناة.");
}

async function handlePrefixCommand(message: Message) {
  if (message.author.bot || !message.inGuild() || !message.channel.isTextBased()) return;
  const command = message.content.trim().toLowerCase();
  if (["!clean", "!تبييض"].includes(command)) await startWizard(message.channel as TextChannel, message.author.id);
  if (["!help", "!مساعدة", "!اوامر"].includes(command)) await sendPanel(message.channel as TextChannel, ["# 📷 Manga Bubble Cleaner", "استخدم `/clean` أو `!clean` للبدء، ثم اختر الوضع وأرسل صورًا أو ZIP أو رابط Google Drive."]);
}

async function registerCommands(client: Client) {
  if (!client.application) throw new Error("Discord application is not ready for global command registration.");
  await client.application.commands.set([cleanCommand.toJSON(), helpCommand.toJSON()]);
}

export function isDiscordBotEnabled(environment: NodeJS.ProcessEnv = process.env) {
  return environment.DISCORD_ENABLED === "true" && Boolean(environment.DISCORD_BOT_TOKEN?.trim());
}

function isUnknownInteractionError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 10062;
}

async function reportInteractionFailure(interaction: { replied: boolean; deferred: boolean; reply: (options: { content: string; flags: typeof EPHEMERAL }) => Promise<unknown>; followUp: (options: { content: string; flags: typeof EPHEMERAL }) => Promise<unknown> }, error: unknown) {
  if (isUnknownInteractionError(error)) {
    console.warn("[discord] ignored expired interaction");
    return;
  }
  console.error("[discord] interaction handler failed", error instanceof Error ? error.message : error);
  const message = "تعذّر إكمال التفاعل. ابدأ `/clean` مرة أخرى إذا كانت اللوحة قديمة.";
  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: message, flags: EPHEMERAL });
    else await interaction.reply({ content: message, flags: EPHEMERAL });
  } catch (replyError) {
    if (!isUnknownInteractionError(replyError)) console.error("[discord] failed to report interaction error", replyError instanceof Error ? replyError.message : replyError);
  }
}

async function routeInteraction(interaction: Parameters<Client["emit"]>[1] & { isChatInputCommand: () => boolean; isButton: () => boolean }) {
  if (interaction.isChatInputCommand()) {
    const command = interaction as unknown as ChatInputCommandInteraction;
    if (command.commandName === "clean") await handleClean(command);
    if (command.commandName === "help") await handleHelp(command);
    return;
  }
  if (interaction.isButton()) {
    const button = interaction as unknown as ButtonInteraction;
    if (button.customId.startsWith("mbc-mode:")) await handleModeButton(button);
  }
}

export function startDiscordBot() {
  if (!isDiscordBotEnabled()) { console.info("[discord] bot disabled: set DISCORD_ENABLED=true and DISCORD_BOT_TOKEN"); return; }
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await registerCommands(client);
      await client.user?.setPresence({ activities: [{ name: "Manga Bubble Cleaner | /help", type: 3 }], status: "online" });
      console.info(`[discord] ready as ${readyClient.user.tag}`);
    } catch (error) { console.error("[discord] command registration failed", error instanceof Error ? error.message : error); }
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void routeInteraction(interaction).catch((error) => {
      if (interaction.isRepliable()) void reportInteractionFailure(interaction as unknown as Parameters<typeof reportInteractionFailure>[0], error);
      else console.error("[discord] non-repliable interaction failed", error instanceof Error ? error.message : error);
    });
  });
  client.on(Events.MessageCreate, (message) => { void handlePrefixCommand(message).catch((error) => console.error("[discord] prefix command failed", error instanceof Error ? error.message : error)); });
  client.on(Events.Error, (error) => console.error("[discord] client error", error.message));
  client.login(process.env.DISCORD_BOT_TOKEN!.trim()).catch((error) => console.error("[discord] login failed", error instanceof Error ? error.message : error));
}
