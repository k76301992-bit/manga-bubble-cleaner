import { AttachmentBuilder, Client, Events, GatewayIntentBits, SlashCommandBuilder, type Attachment } from "discord.js";
import { MAX_IMAGE_BYTES, ProcessingRequestError, processImageInMemory, supportedImageTypes } from "./processing-service";

const cleanCommand = new SlashCommandBuilder()
  .setName("clean")
  .setDescription("Remove dialogue text from one manhwa bubble page")
  .addAttachmentOption((option) => option.setName("image").setDescription("PNG, JPG, or WebP page").setRequired(true))
  .addStringOption((option) => option.setName("quality").setDescription("Cleaning quality").addChoices(
    { name: "Preserve detail", value: "preserve-detail" },
    { name: "Balanced", value: "balanced" },
    { name: "Maximum detail", value: "maximum-detail" },
  ));

type DiscordAttachmentInput = Pick<Attachment, "url" | "name" | "size" | "contentType">;

function mimeTypeForAttachment(attachment: DiscordAttachmentInput) {
  const declared = attachment.contentType?.split(";")[0].toLowerCase();
  if (declared && supportedImageTypes.has(declared)) return declared;
  const extension = attachment.name.toLowerCase().split(".").pop();
  return extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "webp" ? "image/webp" : undefined;
}

export function validateDiscordImageAttachment(attachment: DiscordAttachmentInput) {
  let parsed: URL;
  try { parsed = new URL(attachment.url); } catch { return "رابط مرفق Discord غير صالح."; }
  if (parsed.protocol !== "https:") return "يجب أن يكون مرفق Discord عبر HTTPS.";
  if (!new Set(["cdn.discordapp.com", "media.discordapp.net"]).has(parsed.hostname.toLowerCase())) return "يجب أن يكون الملف مرفقًا من Discord نفسه.";
  if (!mimeTypeForAttachment(attachment)) return "ارفع صفحة PNG أو JPG أو WebP فقط.";
  if (!attachment.size || attachment.size > MAX_IMAGE_BYTES) return "يجب ألا تتجاوز الصورة 20 ميغابايت.";
  return undefined;
}

async function registerCommand(client: Client) {
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  if (!guildId) throw new Error("DISCORD_GUILD_ID is required for the initial private bot deployment.");
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([cleanCommand.toJSON()]);
}

export function startDiscordBot() {
  if (process.env.DISCORD_ENABLED !== "true") { console.info("[discord] bot disabled: set DISCORD_ENABLED=true to enable it"); return; }
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) { console.info("[discord] bot disabled: DISCORD_BOT_TOKEN is not configured"); return; }
  if (!process.env.DISCORD_GUILD_ID?.trim()) { console.info("[discord] bot disabled: DISCORD_GUILD_ID is required for the initial private deployment"); return; }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once(Events.ClientReady, async (readyClient) => {
    try { await registerCommand(client); console.info(`[discord] ready as ${readyClient.user.tag}`); }
    catch (error) { console.error("[discord] command registration failed", error instanceof Error ? error.message : error); }
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "clean") return;
    const attachment = interaction.options.getAttachment("image", true);
    const invalidMessage = validateDiscordImageAttachment(attachment);
    if (invalidMessage) { await interaction.reply({ content: invalidMessage, ephemeral: true }); return; }

    await interaction.deferReply({ ephemeral: true });
    try {
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("تعذر تنزيل مرفق Discord المؤقت.");
      const image = Buffer.from(await response.arrayBuffer());
      const mimeType = mimeTypeForAttachment(attachment);
      if (!mimeType) throw new Error("نوع الصورة غير مدعوم.");
      const quality = interaction.options.getString("quality") ?? "preserve-detail";
      const result = await processImageInMemory({ image, mimeType, fileName: attachment.name, quality: quality as "balanced" | "preserve-detail" | "maximum-detail" });
      const outputName = `${result.fileName.replace(/\.[^.]+$/, "")}-clean.png`;
      await interaction.editReply({ content: `اكتملت المعالجة. معرّف المهمة: ${result.jobId}`, files: [new AttachmentBuilder(result.image, { name: outputName })] });
    } catch (error) {
      const message = error instanceof ProcessingRequestError ? error.message : error instanceof Error ? error.message : "تعذرت معالجة الصورة.";
      await interaction.editReply({ content: `فشلت المعالجة: ${message}` });
    }
  });
  client.login(token).catch((error) => console.error("[discord] login failed", error instanceof Error ? error.message : error));
}
