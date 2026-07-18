// bot.js — Mail Bot + OAuth2 Link System
require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  EmbedBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const pool = require('./db');
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

client.once('clientReady', () => console.log(`✅ Mail Bot online: ${client.user.tag}`));

// ─── OAuth2 API ───────────────────────────────────────────────────────────────

// POST /oauth/request — เว็บขอส่ง code ไปหา Discord user
app.post('/oauth/request', async (req, res) => {
  const { discord_id, web_user_id } = req.body;
  if (req.headers['x-api-secret'] !== process.env.OAUTH_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!discord_id || !web_user_id) return res.status(400).json({ error: 'Missing discord_id or web_user_id' });
  try {
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO oauth_codes (discord_id, web_user_id, code, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (discord_id) DO UPDATE SET code=$3, web_user_id=$2, expires_at=$4, verified=false`,
      [discord_id, web_user_id, code, expiresAt]
    );
    try {
      const user = await client.users.fetch(discord_id);
      await user.send({ embeds: [new EmbedBuilder()
        .setColor(0xf97316).setTitle('🔐 รหัสยืนยัน Boxxland')
        .setDescription(`รหัสยืนยันของคุณคือ:\n\n# \`${code}\``)
        .addFields({ name: '⏱️ หมดอายุใน', value: '10 นาที', inline: true }, { name: '⚠️', value: 'อย่าแชร์รหัสนี้กับใคร!', inline: true })
        .setFooter({ text: 'Boxxland OAuth2' }).setTimestamp()
      ]});
    } catch { return res.status(400).json({ error: 'ไม่สามารถส่ง DM ได้' }); }
    return res.json({ success: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Internal error' }); }
});

// POST /oauth/verify — เว็บส่ง code มา verify
app.post('/oauth/verify', async (req, res) => {
  const { discord_id, code } = req.body;
  if (req.headers['x-api-secret'] !== process.env.OAUTH_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query('SELECT * FROM oauth_codes WHERE discord_id=$1 AND code=$2 AND verified=false', [discord_id, code]);
    if (!result.rows[0]) return res.status(400).json({ error: 'รหัสไม่ถูกต้องหรือใช้ไปแล้ว' });
    if (new Date() > new Date(result.rows[0].expires_at)) return res.status(400).json({ error: 'รหัสหมดอายุแล้ว' });
    await pool.query('UPDATE oauth_codes SET verified=true WHERE discord_id=$1', [discord_id]);
    await pool.query(
      `INSERT INTO discord_links (discord_id, web_user_id, linked_at) VALUES ($1,$2,now())
       ON CONFLICT (discord_id) DO UPDATE SET web_user_id=$2, linked_at=now()`,
      [discord_id, result.rows[0].web_user_id]
    );
    try {
      const user = await client.users.fetch(discord_id);
      await user.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ เชื่อมบัญชีสำเร็จ!').setDescription('Discord ของคุณเชื่อมกับ Boxxland แล้วครับ 🎉').setTimestamp()] });
    } catch {}
    return res.json({ success: true, discord_id, web_user_id: result.rows[0].web_user_id });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Internal error' }); }
});

// GET /oauth/status/:discord_id
app.get('/oauth/status/:discord_id', async (req, res) => {
  if (req.headers['x-api-secret'] !== process.env.OAUTH_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query('SELECT * FROM discord_links WHERE discord_id=$1', [req.params.discord_id]);
    if (!result.rows[0]) return res.json({ linked: false });
    return res.json({ linked: true, web_user_id: result.rows[0].web_user_id, linked_at: result.rows[0].linked_at });
  } catch (err) { return res.status(500).json({ error: 'Internal error' }); }
});

// DELETE /oauth/unlink/:discord_id
app.delete('/oauth/unlink/:discord_id', async (req, res) => {
  if (req.headers['x-api-secret'] !== process.env.OAUTH_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM discord_links WHERE discord_id=$1', [req.params.discord_id]);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Internal error' }); }
});

// ─── Discord Interactions ─────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'register') return openRegisterModal(interaction);
    if (interaction.commandName === 'mail') return handleMail(interaction);
    if (interaction.commandName === 'mailbox') return handleMailbox(interaction);
    if (interaction.commandName === 'reply') return openReplyModal(interaction);
    if (interaction.commandName === 'link') return handleLink(interaction);
    if (interaction.commandName === 'linkstatus') return handleLinkStatus(interaction);
    if (interaction.commandName === 'unlink') return handleUnlink(interaction);
  }
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'mailRegisterModal') return handleRegisterSubmit(interaction);
    if (interaction.customId === 'mailReplyModal') return handleReplySubmit(interaction);
    if (interaction.customId.startsWith('replyToModal_')) return handleReplyToSubmit(interaction);
    if (interaction.customId === 'linkVerifyModal') return handleLinkVerify(interaction);
  }
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('openMail_')) return handleOpenMail(interaction);
    if (interaction.customId.startsWith('replyBtn_')) return handleReplyBtn(interaction);
    if (interaction.customId.startsWith('deleteBtn_')) return handleDeleteBtn(interaction);
    if (interaction.customId.startsWith('mailboxPage_')) return handleMailboxPage(interaction);
    if (interaction.customId === 'linkVerifyBtn') return openLinkVerifyModal(interaction);
  }
});

// ─── /link ────────────────────────────────────────────────────────────────────
async function handleLink(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const existing = await pool.query('SELECT * FROM discord_links WHERE discord_id=$1', [interaction.user.id]);
    if (existing.rows[0]) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ เชื่อมบัญชีแล้ว')
        .setDescription('Discord ของคุณเชื่อมกับ Boxxland แล้วครับ')
        .addFields({ name: '🔗 Web User ID', value: `\`${existing.rows[0].web_user_id}\``, inline: true })
        .setTimestamp()
      ]});
    }
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO oauth_codes (discord_id, web_user_id, code, expires_at) VALUES ($1,'', $2, $3)
       ON CONFLICT (discord_id) DO UPDATE SET code=$2, expires_at=$3, verified=false`,
      [interaction.user.id, code, expiresAt]
    );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('linkVerifyBtn').setLabel('ยืนยันรหัส').setStyle(ButtonStyle.Success).setEmoji('🔑'),
    );
    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor(0xf97316).setTitle('🔐 เชื่อมบัญชี Boxxland')
      .setDescription(`รหัสยืนยันของคุณ:\n\n# \`${code}\`\n\nนำรหัสนี้ไปกรอกบนเว็บ Boxxland แล้วกด **ยืนยันรหัส** ด้านล่างครับ`)
      .addFields({ name: '⏱️ หมดอายุใน', value: '10 นาที', inline: true })
      .setFooter({ text: 'อย่าแชร์รหัสนี้กับใคร!' }).setTimestamp()
    ], components: [row] });
  } catch (err) { console.error(err); return interaction.editReply('❌ เกิดข้อผิดพลาด'); }
}

function openLinkVerifyModal(interaction) {
  const modal = new ModalBuilder().setCustomId('linkVerifyModal').setTitle('🔑 ยืนยันการเชื่อมบัญชี');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('verifyCode').setLabel('รหัส 6 หลักจากเว็บ Boxxland')
      .setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6).setRequired(true).setPlaceholder('เช่น 123456')
  ));
  return interaction.showModal(modal);
}

async function handleLinkVerify(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const code = interaction.fields.getTextInputValue('verifyCode').trim();
  try {
    const result = await pool.query('SELECT * FROM oauth_codes WHERE discord_id=$1 AND code=$2 AND verified=false', [interaction.user.id, code]);
    if (!result.rows[0]) return interaction.editReply('❌ รหัสไม่ถูกต้องหรือใช้ไปแล้วครับ');
    if (new Date() > new Date(result.rows[0].expires_at)) return interaction.editReply('❌ รหัสหมดอายุแล้ว กด `/link` อีกครั้งครับ');
    await pool.query('UPDATE oauth_codes SET verified=true WHERE discord_id=$1', [interaction.user.id]);
    await pool.query(
      `INSERT INTO discord_links (discord_id, web_user_id, linked_at) VALUES ($1,$2,now())
       ON CONFLICT (discord_id) DO UPDATE SET web_user_id=$2, linked_at=now()`,
      [interaction.user.id, result.rows[0].web_user_id || interaction.user.id]
    );
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ เชื่อมบัญชีสำเร็จ!').setDescription('บัญชี Discord ของคุณเชื่อมกับ Boxxland แล้วครับ 🎉').setTimestamp()] });
  } catch (err) { console.error(err); return interaction.editReply('❌ เกิดข้อผิดพลาด'); }
}

async function handleLinkStatus(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await pool.query('SELECT * FROM discord_links WHERE discord_id=$1', [interaction.user.id]);
    if (!result.rows[0]) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('❌ ยังไม่ได้เชื่อมบัญชี').setDescription('ใช้ `/link` เพื่อเชื่อมบัญชี Boxxland ครับ')] });
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ เชื่อมบัญชีแล้ว')
      .addFields({ name: '🔗 Web User ID', value: `\`${result.rows[0].web_user_id}\``, inline: true }, { name: '📅 เชื่อมเมื่อ', value: new Date(result.rows[0].linked_at).toLocaleString('th-TH'), inline: true })
      .setTimestamp()
    ]});
  } catch (err) { return interaction.editReply('❌ เกิดข้อผิดพลาด'); }
}

async function handleUnlink(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await pool.query('DELETE FROM discord_links WHERE discord_id=$1', [interaction.user.id]);
  return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🔓 ยกเลิกการเชื่อมต่อแล้ว').setDescription('ยกเลิกการเชื่อมบัญชี Boxxland แล้วครับ').setTimestamp()] });
}

// ─── Mail Commands (เหมือนเดิม) ──────────────────────────────────────────────
function openRegisterModal(interaction) {
  const modal = new ModalBuilder().setCustomId('mailRegisterModal').setTitle('สมัครบัญชี Mail Bot');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('username').setLabel('Username (a-z, 0-9, _)').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(20).setRequired(true)
  ));
  return interaction.showModal(modal);
}

async function handleRegisterSubmit(interaction) {
  const username = interaction.fields.getTextInputValue('username').trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return interaction.reply({ content: '⚠️ username ต้องเป็น a-z, 0-9, _ เท่านั้น', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  try {
    const byDiscord = await pool.query('SELECT * FROM mailnot_users WHERE discord_id=$1', [interaction.user.id]);
    if (byDiscord.rows.length > 0) return interaction.editReply(`⚠️ ลงทะเบียนแล้วในชื่อ \`${byDiscord.rows[0].username}\``);
    const byName = await pool.query('SELECT discord_id FROM mailnot_users WHERE username=$1', [username]);
    if (byName.rows.length > 0) return interaction.editReply(`⚠️ username \`${username}\` มีคนใช้แล้ว`);
    await pool.query('INSERT INTO mailnot_users (discord_id, username) VALUES ($1,$2)', [interaction.user.id, username]);
    return interaction.editReply(`✅ ลงทะเบียนสำเร็จ! ชื่อ \`${username}\` 📬`);
  } catch (err) { console.error(err); return interaction.editReply('❌ เกิดข้อผิดพลาด'); }
}

async function handleMail(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const sender = await getMailUser(interaction.user.id);
    if (!sender) return interaction.editReply('⚠️ ยังไม่ได้ลงทะเบียน — ใช้ `/register` ก่อนนะ');
    const target = interaction.options.getUser('user');
    const body = interaction.options.getString('message');
    if (target.bot) return interaction.editReply('⚠️ ส่งหาบอทไม่ได้');
    if (target.id === interaction.user.id) return interaction.editReply('⚠️ ส่งหาตัวเองทำไมล่ะ 😄');
    const recipient = await getMailUser(target.id);
    if (!recipient) return interaction.editReply(`⚠️ ${target.tag} ยังไม่ได้ลงทะเบียน Mail Bot`);
    await deliverMail(interaction.user.id, target.id, body, sender.username, target, recipient.username);
    return interaction.editReply(`✅ ส่งถึง \`${recipient.username}\` แล้ว 📨`);
  } catch (err) { console.error(err); return interaction.editReply('❌ เกิดข้อผิดพลาด'); }
}

async function handleMailbox(interaction, page = 0, editInteraction = null) {
  const target = editInteraction || interaction;
  if (!editInteraction) await interaction.deferReply({ ephemeral: true });
  try {
    const user = await getMailUser(interaction.user.id);
    if (!user) return target.editReply('⚠️ ยังไม่ได้ลงทะเบียน');
    const PAGE_SIZE = 5; const offset = page * PAGE_SIZE;
    const total = parseInt((await pool.query('SELECT COUNT(*) FROM mailnot_messages WHERE to_discord_id=$1', [interaction.user.id])).rows[0].count);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const inbox = (await pool.query(
      `SELECT m.id, m.body, m.created_at, mu.username AS from_username FROM mailnot_messages m
       LEFT JOIN mailnot_users mu ON mu.discord_id = m.from_discord_id
       WHERE m.to_discord_id=$1 ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
      [interaction.user.id, PAGE_SIZE, offset]
    )).rows;
    const embed = new EmbedBuilder().setTitle('📬 Mail.gg').setColor(0xf97316)
      .setDescription(`**กล่องข้อความของ \`${user.username}\`**\n──────────────────`);
    if (!inbox.length) embed.addFields({ name: '📭 ว่างเปล่า', value: 'ยังไม่มีเมลเลย' });
    else embed.addFields({ name: '\u200b', value: inbox.map((m, i) => `\`${offset+i+1}.\` 📧 **${m.from_username||'???'}** — ${m.body.length>30?m.body.slice(0,30)+'…':m.body}`).join('\n') });
    embed.setFooter({ text: `หน้า ${page+1}/${totalPages} · รวม ${total} เมล` });
    const mailBtns = inbox.map((m,i) => new ButtonBuilder().setCustomId(`openMail_${m.id}_${interaction.user.id}_${page}`).setLabel(`เปิดเมล ${offset+i+1}`).setStyle(ButtonStyle.Secondary).setEmoji('📨'));
    const nav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mailboxPage_${interaction.user.id}_${page-1}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(page===0),
      new ButtonBuilder().setCustomId(`mailboxPage_${interaction.user.id}_${page+1}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(page>=totalPages-1)
    );
    const components = [];
    for (let i=0;i<mailBtns.length;i+=5) components.push(new ActionRowBuilder().addComponents(mailBtns.slice(i,i+5)));
    components.push(nav);
    return target.editReply({ embeds: [embed], components });
  } catch (err) { console.error(err); return target.editReply('❌ เกิดข้อผิดพลาด'); }
}

async function handleMailboxPage(interaction) {
  const parts = interaction.customId.split('_'); const page = parseInt(parts[2]);
  await interaction.deferUpdate(); return handleMailbox(interaction, page, interaction);
}

async function handleOpenMail(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const mailId = parseInt(interaction.customId.split('_')[1]);
    const mail = (await pool.query(`SELECT m.*, mu.username AS from_username, mu2.username AS to_username FROM mailnot_messages m LEFT JOIN mailnot_users mu ON mu.discord_id=m.from_discord_id LEFT JOIN mailnot_users mu2 ON mu2.discord_id=m.to_discord_id WHERE m.id=$1`, [mailId])).rows[0];
    if (!mail) return interaction.editReply('⚠️ ไม่พบเมลนี้');
    let avatar = '📧'; try { avatar = (await client.users.fetch(mail.from_discord_id)).displayAvatarURL({size:64}); } catch {}
    const embed = new EmbedBuilder().setColor(0xf97316).setAuthor({name:mail.from_username||'???',iconURL:avatar}).setTitle('📩 เมลใหม่').setDescription(mail.body)
      .addFields({name:'จาก',value:`\`${mail.from_username||'???'}\``,inline:true},{name:'ถึง',value:`\`${mail.to_username||'???'}\``,inline:true},{name:'เวลา',value:new Date(mail.created_at).toLocaleString('th-TH'),inline:true})
      .setFooter({text:'Mail.gg'});
    if (mail.reply_body) embed.addFields({name:`↩️ ตอบกลับโดย ${mail.reply_from_username||'???'}`,value:mail.reply_body});
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`replyBtn_${mail.from_discord_id}_${mailId}`).setLabel('ตอบกลับ').setStyle(ButtonStyle.Primary).setEmoji('↩️'),
      new ButtonBuilder().setCustomId(`deleteBtn_${mailId}`).setLabel('ลบเมล').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    );
    return interaction.editReply({ embeds:[embed], components:[row] });
  } catch (err) { console.error(err); return interaction.editReply('❌ เกิดข้อผิดพลาด'); }
}

async function handleReplyBtn(interaction) {
  const parts = interaction.customId.split('_');
  const modal = new ModalBuilder().setCustomId(`replyToModal_${parts[1]}_${parts[2]}`).setTitle('ตอบกลับเมล');
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('replyBody').setLabel('ข้อความตอบกลับ').setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(1000).setRequired(true)));
  return interaction.showModal(modal);
}

async function handleReplyToSubmit(interaction) {
  const parts = interaction.customId.split('_'); const toDiscordId=parts[1]; const mailId=parseInt(parts[2]);
  await interaction.deferReply({ephemeral:true});
  try {
    const sender=await getMailUser(interaction.user.id); if(!sender) return interaction.editReply('⚠️ ยังไม่ได้ลงทะเบียน');
    const body=interaction.fields.getTextInputValue('replyBody');
    const recipient=await getMailUser(toDiscordId); if(!recipient) return interaction.editReply('⚠️ คนที่รับยกเลิกบัญชีไปแล้ว');
    const targetUser=await client.users.fetch(toDiscordId).catch(()=>null); if(!targetUser) return interaction.editReply('⚠️ หาผู้รับไม่เจอ');
    const mailRow=(await pool.query('SELECT * FROM mailnot_messages WHERE id=$1',[mailId])).rows[0];
    if(mailRow) { await editOriginalMailWithReply(mailRow,body,sender.username); await pool.query('UPDATE mailnot_messages SET reply_body=$1,reply_from_username=$2 WHERE id=$3',[body,sender.username,mailId]); }
    await deliverMail(interaction.user.id,toDiscordId,body,sender.username,targetUser,recipient.username);
    return interaction.editReply(`✅ ตอบกลับถึง \`${recipient.username}\` แล้ว 📨`);
  } catch (err) { console.error(err); return interaction.editReply('❌ เกิดข้อผิดพลาด'); }
}

async function handleDeleteBtn(interaction) {
  await interaction.deferUpdate();
  try { await pool.query('DELETE FROM mailnot_messages WHERE id=$1 AND to_discord_id=$2',[parseInt(interaction.customId.split('_')[1]),interaction.user.id]); return interaction.editReply({content:'🗑️ ลบเมลแล้ว',embeds:[],components:[]}); }
  catch (err) { return interaction.followUp({content:'❌ เกิดข้อผิดพลาด',ephemeral:true}); }
}

function openReplyModal(interaction) {
  const modal = new ModalBuilder().setCustomId('mailReplyModal').setTitle('ตอบกลับเมลล่าสุด');
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('replyBody').setLabel('ข้อความตอบกลับ').setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(1000).setRequired(true)));
  return interaction.showModal(modal);
}

async function handleReplySubmit(interaction) {
  await interaction.deferReply({ephemeral:true});
  try {
    const sender=await getMailUser(interaction.user.id); if(!sender) return interaction.editReply('⚠️ ยังไม่ได้ลงทะเบียน');
    const body=interaction.fields.getTextInputValue('replyBody');
    const mailRow=(await pool.query('SELECT * FROM mailnot_messages WHERE to_discord_id=$1 ORDER BY created_at DESC LIMIT 1',[interaction.user.id])).rows[0];
    if(!mailRow) return interaction.editReply('⚠️ ไม่มีเมลที่จะตอบกลับ');
    const recipient=await getMailUser(mailRow.from_discord_id); if(!recipient) return interaction.editReply('⚠️ คนที่รับยกเลิกบัญชีไปแล้ว');
    const targetUser=await client.users.fetch(mailRow.from_discord_id).catch(()=>null); if(!targetUser) return interaction.editReply('⚠️ หาผู้รับไม่เจอ');
    await editOriginalMailWithReply(mailRow,body,sender.username);
    await pool.query('UPDATE mailnot_messages SET reply_body=$1,reply_from_username=$2 WHERE id=$3',[body,sender.username,mailRow.id]);
    await deliverMail(interaction.user.id,mailRow.from_discord_id,body,sender.username,targetUser,recipient.username);
    return interaction.editReply(`✅ ตอบกลับถึง \`${recipient.username}\` แล้ว 📨`);
  } catch (err) { console.error(err); return interaction.editReply('❌ เกิดข้อผิดพลาด'); }
}

async function deliverMail(fromId,toId,body,fromUsername,targetUser,toUsername) {
  const msg=await targetUser.send({embeds:[new EmbedBuilder().setColor(0xf97316).setAuthor({name:fromUsername}).setTitle('📩 เมลใหม่').setDescription(body).setFooter({text:'Mail.gg · ตอบกลับด้วย /reply หรือดูใน /mailbox'}).setTimestamp()]});
  await pool.query('INSERT INTO mailnot_messages (from_discord_id,to_discord_id,body,dm_message_id,dm_channel_id) VALUES ($1,$2,$3,$4,$5)',[fromId,toId,body,msg.id,msg.channelId]);
}

async function editOriginalMailWithReply(mailRow,replyBody,replyFromUsername) {
  if(!mailRow.dm_message_id||!mailRow.dm_channel_id) return;
  try {
    const ch=await client.channels.fetch(mailRow.dm_channel_id);
    const orig=await ch.messages.fetch(mailRow.dm_message_id);
    await orig.edit({embeds:[EmbedBuilder.from(orig.embeds[0]).addFields({name:`↩️ ตอบกลับโดย ${replyFromUsername}`,value:replyBody})]});
  } catch (err) { console.error('Edit mail error:',err); }
}

async function getMailUser(discordId) {
  return (await pool.query('SELECT * FROM mailnot_users WHERE discord_id=$1',[discordId])).rows[0]||null;
}

app.listen(PORT, () => console.log(`🌐 OAuth2 API on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN);
