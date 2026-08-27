import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events,
  GatewayIntentBits, MessageFlags, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type Attachment, type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction,
} from "discord.js";
import { type CleaningQuality } from "./cleaner";
import { cleanBatchInMemory, createResultZip, extractImagesFromZip, MAX_IMAGES_PER_BATCH, MAX_ZIP_BYTES, mimeTypeForFileName, type BatchImage } from "./batch-processing";
import { createGoogleDriveResultFolder, readGoogleDriveSource } from "./google-drive";

const EPHEMERAL = MessageFlags.Ephemeral;
const DRIVE_MODAL_ID = "mbc-drive-link";
const ATTACHMENTS_BUTTON_ID = "mbc-source-attachments";
const DRIVE_BUTTON_ID = "mbc-source-drive";
const QUALITY_BUTTON_ID = "mbc-quality";
const MAX_DISCORD_RESULT_BYTES = 24 * 1024 * 1024;
const qualityChoices = [
  { name: "حفظ التفاصيل — موصى به", value: "preserve-detail" },
  { name: "متوازن", value: "balanced" },
  { name: "تفاصيل قصوى", value: "maximum-detail" },
] as const;

const cleanCommand = new SlashCommandBuilder()
  .setName("clean")
  .setDescription("تنظيف نصوص فقاعات صفحة أو فصل مانهوا")
  .addStringOption((option) => option.setName("quality").setDescription("مستوى الترميم").addChoices(...qualityChoices));
const helpCommand = new SlashCommandBuilder().setName("help").setDescription("شرح مصادر الفصل وطريقة استلام النتيجة");
type DiscordAttachmentInput = Pick<Attachment, "url" | "name" | "size" | "contentType">;
type SourceKind = "discord-images" | "zip" | "drive";
type SourceBatch = { kind: SourceKind; sourceName: string; images: BatchImage[] };

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

function qualityFor(value: string | null | undefined): CleaningQuality {
  return value === "balanced" || value === "maximum-detail" ? value : "preserve-detail";
}

function studioEmbed(quality: CleaningQuality) {
  return new EmbedBuilder()
    .setColor(0xC8A45C)
    .setTitle("Manga Bubble Cleaner · استوديو التبييض")
    .setDescription("اختر مصدر الفصل. تُحفظ الصور في الذاكرة أثناء المعالجة فقط، وتُعاد النتيجة بالطريقة المطابقة للمصدر.")
    .addFields(
      { name: "مرفقات Discord", value: `أرسل حتى ${MAX_IMAGES_PER_BATCH} صور مباشرة، أو ملف ZIP واحد. الصور تعود مرفقات، وZIP يعود ZIP.`, inline: false },
      { name: "Google Drive", value: "ألصق رابط صورة أو ZIP أو مجلد مشترك مع حساب الخدمة؛ ينشأ مجلد نتائج جديد ويصل رابطُه إليك.", inline: false },
      { name: "المستوى", value: quality === "maximum-detail" ? "تفاصيل قصوى" : quality === "balanced" ? "متوازن" : "حفظ التفاصيل", inline: true },
    )
    .setFooter({ text: "لا تُحفظ صورك ولا نتائجك على قرص الخادم." });
}

function qualityButtons() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${QUALITY_BUTTON_ID}:preserve-detail`).setLabel("حفظ التفاصيل").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${QUALITY_BUTTON_ID}:balanced`).setLabel("متوازن").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${QUALITY_BUTTON_ID}:maximum-detail`).setLabel("تفاصيل قصوى").setStyle(ButtonStyle.Secondary),
  );
}

function sourceButtons(quality: CleaningQuality) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${ATTACHMENTS_BUTTON_ID}:${quality}`).setLabel("مرفقات أو ZIP").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${DRIVE_BUTTON_ID}:${quality}`).setLabel("Google Drive").setStyle(ButtonStyle.Secondary),
  );
}

async function fetchAttachmentBytes(attachment: DiscordAttachmentInput) {
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error("تعذر تنزيل مرفق Discord المؤقت.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > Math.max(attachment.size ?? 0, MAX_ZIP_BYTES) || buffer.length > MAX_ZIP_BYTES) throw new Error("حجم الملف بعد التنزيل يتجاوز الحد الآمن.");
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

async function collectDiscordAttachments(interaction: ButtonInteraction) {
  if (!interaction.inGuild() || !interaction.channel?.isTextBased()) throw new Error("استخدم هذا المسار داخل قناة نصية في خادم Discord.");
  const channel = interaction.channel;
  await interaction.editReply(`أرسل الآن حتى **${MAX_IMAGES_PER_BATCH}** صور، أو ملف ZIP واحد، في هذه القناة خلال خمس دقائق. سأقرأ رسالة المرفقات هذه فقط.`);
  const messages = await channel.awaitMessages({ filter: (message) => message.author.id === interaction.user.id && message.attachments.size > 0, max: 1, time: 5 * 60_000, errors: ["time"] });
  return [...messages.first()!.attachments.values()];
}

async function deliverDiscordResult(interaction: ButtonInteraction | ModalSubmitInteraction, source: SourceBatch, results: Awaited<ReturnType<typeof cleanBatchInMemory>>) {
  if (source.kind === "drive") {
    const folder = await createGoogleDriveResultFolder({ sourceName: source.sourceName, results });
    await interaction.editReply(`اكتملت معالجة **${results.length}** صورة. أنشأت مجلد النتائج وشاركته للقراءة عبر الرابط التالي:\n${folder.url}`);
    return;
  }
  if (source.kind === "zip") {
    const zip = await createResultZip(results);
    await interaction.editReply({ content: `اكتملت معالجة **${results.length}** صورة. هذا ZIP الناتج:`, files: [new AttachmentBuilder(zip, { name: `${source.sourceName}-cleaned.zip` })] });
    return;
  }
  const totalBytes = results.reduce((total, result) => total + result.image.length, 0);
  if (totalBytes > MAX_DISCORD_RESULT_BYTES) throw new Error("نتائج الصور أكبر من حد الإرسال في Discord. أرسلها كملف ZIP أو استخدم Google Drive.");
  await interaction.editReply({ content: `اكتملت معالجة **${results.length}** صورة.`, files: results.map((result) => new AttachmentBuilder(result.image, { name: result.outputName })) });
}

async function processSource(interaction: ButtonInteraction | ModalSubmitInteraction, source: SourceBatch, quality: CleaningQuality) {
  await interaction.editReply("**جاري فحص المصدر…**");
  const results = await cleanBatchInMemory({
    images: source.images,
    quality,
    onProgress: async (current, total, name) => {
      await interaction.editReply(current === total ? "**جاري تجهيز النتائج…**" : `**جاري تنظيف الصفحة ${current + 1}/${total}**\n\`${name}\``);
    },
  });
  await deliverDiscordResult(interaction, source, results);
}

function driveModal(quality: CleaningQuality) {
  const input = new TextInputBuilder().setCustomId("link").setLabel("رابط Google Drive").setPlaceholder("https://drive.google.com/drive/folders/…").setRequired(true).setStyle(TextInputStyle.Paragraph);
  return new ModalBuilder().setCustomId(`${DRIVE_MODAL_ID}:${quality}`).setTitle("معالجة من Google Drive").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

async function handleCleanCommand(interaction: ChatInputCommandInteraction) {
  const quality = qualityFor(interaction.options.getString("quality"));
  if (interaction.options.getString("quality")) {
    await interaction.reply({ embeds: [studioEmbed(quality)], components: [sourceButtons(quality)], flags: EPHEMERAL });
    return;
  }
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xC8A45C).setTitle("Manga Bubble Cleaner · اختر المستوى").setDescription("اختر المستوى أولًا، ثم اختر مصدر صور الفصل. مستوى **حفظ التفاصيل** هو الافتراضي الموصى به.")],
    components: [qualityButtons()],
    flags: EPHEMERAL,
  });
}

async function handleAttachmentButton(interaction: ButtonInteraction, quality: CleaningQuality) {
  await interaction.deferReply({ flags: EPHEMERAL });
  try {
    const source = await sourceFromDiscordAttachments(await collectDiscordAttachments(interaction));
    await processSource(interaction, source, quality);
  } catch (error) {
    await interaction.editReply(`تعذرت المعالجة: ${error instanceof Error ? error.message : "خطأ غير معروف."}`);
  }
}

async function handleDriveModal(interaction: ModalSubmitInteraction, quality: CleaningQuality) {
  await interaction.deferReply({ flags: EPHEMERAL });
  try {
    const driveSource = await readGoogleDriveSource(interaction.fields.getTextInputValue("link").trim());
    await processSource(interaction, { ...driveSource, kind: "drive" }, quality);
  } catch (error) {
    await interaction.editReply(`تعذرت المعالجة: ${error instanceof Error ? error.message : "خطأ غير معروف."}`);
  }
}

async function registerCommands(client: Client) {
  if (!client.application) throw new Error("Discord application is not ready for global command registration.");
  await client.application.commands.set([cleanCommand.toJSON(), helpCommand.toJSON()]);
}

export function isDiscordBotEnabled(environment: NodeJS.ProcessEnv = process.env) {
  return environment.DISCORD_ENABLED === "true" && Boolean(environment.DISCORD_BOT_TOKEN?.trim());
}

export function startDiscordBot() {
  if (!isDiscordBotEnabled()) { console.info("[discord] bot disabled: set DISCORD_ENABLED=true and DISCORD_BOT_TOKEN"); return; }
  const token = process.env.DISCORD_BOT_TOKEN!.trim();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.once(Events.ClientReady, async (readyClient) => {
    try { await registerCommands(client); console.info(`[discord] ready as ${readyClient.user.tag}`); }
    catch (error) { console.error("[discord] command registration failed", error instanceof Error ? error.message : error); }
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "clean") await handleCleanCommand(interaction);
      if (interaction.commandName === "help") await interaction.reply({ embeds: [studioEmbed("preserve-detail")], flags: EPHEMERAL });
      return;
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith(`${QUALITY_BUTTON_ID}:`)) {
        const quality = qualityFor(interaction.customId.split(":")[1]);
        await interaction.update({ embeds: [studioEmbed(quality)], components: [sourceButtons(quality)] });
      }
      if (interaction.customId.startsWith(`${ATTACHMENTS_BUTTON_ID}:`)) await handleAttachmentButton(interaction, qualityFor(interaction.customId.split(":")[1]));
      if (interaction.customId.startsWith(`${DRIVE_BUTTON_ID}:`)) await interaction.showModal(driveModal(qualityFor(interaction.customId.split(":")[1])));
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(`${DRIVE_MODAL_ID}:`)) await handleDriveModal(interaction, qualityFor(interaction.customId.split(":")[1]));
  });
  client.login(token).catch((error) => console.error("[discord] login failed", error instanceof Error ? error.message : error));
}
