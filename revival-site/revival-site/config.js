// Edit these for your project. Pick your OWN name and branding.
module.exports = {
  siteName: 'YourSiteName',
  port: process.env.PORT || 3000,

  // Look of the site: 'theme-2016' (flat white/blue), 'theme-2017' (light grey/green) or 'theme-dark'.
  theme: 'theme-2016',

  // Where the launcher installer is hosted (GitHub release, your own server, etc.)
  launcherUrl: '#',

  discordInvite: 'https://discord.gg/your-invite',

  // When true, signup requires a one-time code minted by your Discord bot
  // (POST /api/discord/code). Set false to allow open signups.
  requireDiscordVerification: false,

  // Shared secret for server-to-server endpoints. Set via env in production.
  serverApiKey: process.env.SERVER_API_KEY || 'change-me',
};
