require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, 
    TextInputStyle, Routes, InteractionType, ActivityType 
} = require('discord.js');
const { REST } = require('@discordjs/rest');
const axios = require('axios');
const { Queue } = require('queue-typescript');
const { Mutex } = require('async-mutex');
const winston = require('winston');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const serverRequests = new Map();
const requestQueue = new Map();
const processingLocks = new Map();

// Config bot
const botToken = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const errorChannelId = process.env.ERROR_CHANNEL_ID;
const logChannelId = process.env.LOG_CHANNEL_ID;

// Logger setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'RealYoGalacticBot.log' })
    ]
});

async function getApiLink(content, type) {
    const baseUrl = "https://trw.lat/api/bypass";
    const endpoints = { 
        linkvertise: "linkvertise",
        rekonise: "rekonise",
        workink: "workink"
    };

    return endpoints[type] ? `${baseUrl}/${endpoints[type]}?url=${encodeURIComponent(content)}` : null;
}

async function processNextRequest(guildId) {
    if (!processingLocks.has(guildId)) {
        processingLocks.set(guildId, new Mutex());
    }
    const lock = processingLocks.get(guildId);

    await lock.runExclusive(async () => {
        const queue = requestQueue.get(guildId);
        if (queue && queue.size > 0) {
            const { userId, interaction, apiLink, startTime } = queue.dequeue();
            serverRequests.get(guildId).set(userId, true);

            try {
                const response = await axios.get(apiLink, { timeout: 15000 });
                const jsonData = response.data;

                const bypassData = jsonData.bypassed || jsonData.key || jsonData.result;
                const timeTaken = (Date.now() - startTime) / 1000;

                let embed;
                if (bypassData) {
                    embed = new EmbedBuilder()
                        .setTitle('✅ | Bypass Successful!')
                        .setColor(0x2ECC71)
                        .setThumbnail(interaction.user.displayAvatarURL())
                        .addFields(
                            { name: '🔑 **Bypassed Link / Key:**', value: `\`\`\`\n${bypassData}\n\`\`\`` },
                            { name: '⏱️ **Time Taken:**', value: `${timeTaken.toFixed(2)} seconds`, inline: true },
                            { name: '📝 **Requested by:**', value: interaction.user.tag, inline: true }
                        )
                        .setFooter({ 
                            text: `Made By RealYoGalactic | Server: ${interaction.guild?.name || 'DM'}`, 
                            iconURL: interaction.user.displayAvatarURL() 
                        });

                    const logChannel = client.channels.cache.get(logChannelId);
                    logChannel?.send({ embeds: [embed] }).catch(err => logger.error('Log send failed: ' + err.message));

                } else {
                    embed = new EmbedBuilder()
                        .setTitle('❌ | Bypass Failed')
                        .setDescription('```diff\n- Unable to process the link.\n```')
                        .setColor(0xFF0000)
                        .setFooter({ text: `Made By RealYoGalactic` });
                }

                await interaction.editReply({ embeds: [embed] });

            } catch (error) {
                logger.error(`❌ Error: ${error.message}`);
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ Error')
                    .setDescription('```API is down, please try again later.```')
                    .setColor(0xFF0000);

                client.channels.cache.get(errorChannelId)?.send({ embeds: [errorEmbed] });
                await interaction.editReply({ embeds: [errorEmbed] });
            } finally {
                serverRequests.get(guildId).delete(userId);
                if (queue.size > 0) await processNextRequest(guildId);
            }
        }
    });
}

client.once('ready', async () => {
    try {
        client.user.setPresence({
            activities: [{ name: 'RealYoGalactic', type: ActivityType.Streaming, url: 'https://www.twitch.tv/RealYoGalactic' }],
            status: 'idle'
        });
        logger.info(`Logged in as ${client.user.tag}`);
    } catch (error) {
        logger.error('Error setting presence:', error);
    }

    const rest = new REST({ version: '10' }).setToken(botToken);
    const commands = [
        { name: 'setbypass', description: 'Send the RealYoGalactic bypass embed.' }
    ];

    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        logger.info('✅ Registered slash commands.');
    } catch (error) {
        logger.error('Error registering commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.type === InteractionType.ApplicationCommand && interaction.commandName === 'setbypass') {
        const embed = new EmbedBuilder()
            .setDescription('```API provided by RealYoGalactic```')
            .setImage('https://i.ibb.co/8Mhm24D/miyako1-1.gif')
            .setColor(0xffffff);

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('linkvertise').setLabel('Linkvertise').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('rekonise').setLabel('Rekonise').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('workink').setLabel('Work.ink').setStyle(ButtonStyle.Primary)
            );

        await interaction.reply({ embeds: [embed], components: [row] });
    } 
    else if (interaction.type === InteractionType.MessageComponent) {
        const type = interaction.customId;

        const modal = new ModalBuilder()
            .setCustomId(`bypass_${type}`)
            .setTitle('Enter Your Link');

        const input = new TextInputBuilder()
            .setCustomId('linkInput')
            .setLabel(`Enter your ${type} link`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    } 
    else if (interaction.type === InteractionType.ModalSubmit) {
        const type = interaction.customId.split('_')[1];
        const link = interaction.fields.getTextInputValue('linkInput');

        const apiLink = await getApiLink(link, type);
        if (!apiLink) return await interaction.reply({ content: '❌ Invalid link.', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guildId;
        const userId = interaction.user.id;

        if (!requestQueue.has(guildId)) requestQueue.set(guildId, new Queue());
        const queue = requestQueue.get(guildId);
        queue.enqueue({ userId, interaction, apiLink, startTime: Date.now() });

        if (!serverRequests.has(guildId)) serverRequests.set(guildId, new Map());
        if (serverRequests.get(guildId).size === 0) await processNextRequest(guildId);
    }
});

client.login(botToken);
