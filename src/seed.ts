/**
 * 内置种子清单:远程清单拉不到、本地缓存也没有时的兜底(离线首启、CDN 被墙等)。
 *
 * 这里只放「几乎确定被墙、且日常真会用到」的高频域名,刻意保持小体量 ——
 * 完整清单交给远程 rule-provider,种子清单只保证插件在最坏情况下仍然有用。
 * 用户要补充/纠正,改本地规则文件即可(本地规则优先级最高)。
 */
export const SEED_BLOCKED_DOMAINS: readonly string[] = [
  // Google 全家桶
  'google.com', 'googleapis.com', 'gstatic.com', 'googlevideo.com', 'googleusercontent.com',
  'googlesyndication.com', 'googletagmanager.com', 'google-analytics.com', 'youtube.com',
  'ytimg.com', 'youtu.be', 'ggpht.com', 'blogger.com', 'blogspot.com', 'withgoogle.com',
  // 社交 / 通讯
  'facebook.com', 'fbcdn.net', 'instagram.com', 'whatsapp.com', 'whatsapp.net', 'messenger.com',
  'twitter.com', 'x.com', 'twimg.com', 't.co', 'telegram.org', 'telegram.me', 't.me',
  'signal.org', 'discord.com', 'discordapp.com', 'discord.gg', 'snapchat.com', 'line.me',
  'reddit.com', 'redd.it', 'tumblr.com', 'pinterest.com', 'quora.com', 'medium.com',
  // 百科 / 新闻 / 出版
  'wikipedia.org', 'wikimedia.org', 'wiktionary.org', 'wikisource.org', 'nytimes.com',
  'cn.nytimes.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'reuters.com', 'bloomberg.com',
  'wsj.com', 'economist.com', 'theguardian.com', 'voanews.com', 'rfa.org', 'dw.com',
  'rfi.fr', 'wsj.net', 'ft.com', 'washingtonpost.com',
  // 开发 / AI / 代码托管
  'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com', 'anthropic.com',
  'claude.ai', 'huggingface.co', 'hf.co', 'civitai.com', 'openrouter.ai', 'perplexity.ai',
  'gemini.google.com', 'bard.google.com', 'copilot.microsoft.com', 'midjourney.com',
  'raw.githubusercontent.com', 'githubusercontent.com', 'github.io', 'gist.github.com',
  'gitlab.io', 'docker.io', 'registry-1.docker.io', 'ghcr.io', 'quay.io',
  // 流媒体 / 娱乐 / 图站
  'netflix.com', 'nflxvideo.net', 'twitch.tv', 'ttvnw.net', 'spotify.com', 'scdn.co',
  'soundcloud.com', 'vimeo.com', 'dailymotion.com', 'pixiv.net', 'pximg.net', 'imgur.com',
  '9gag.com', 'deviantart.com', 'patreon.com', 'onlyfans.com', 'pornhub.com', 'xvideos.com',
  'xhamster.com', 'nhentai.net', 'danbooru.donmai.us', 'gelbooru.com', 'rule34.xxx',
  // 工具 / 云服务 / 其它常见被墙项
  'dropbox.com', 'slack.com', 'notion.so', 'figma.com', 'trello.com', 'asana.com',
  'protonmail.com', 'proton.me', 'duckduckgo.com', 'archive.org', 'pastebin.com',
  'bit.ly', 'change.org', 'amnesty.org', 'hrw.org', 'torproject.org', 'speedtest.net',
  'steamcommunity.com', 'akamaihd.net', 'rutracker.org', 'thepiratebay.org', 'torrentz.eu',
  '4chan.org', 'linkedin.com', 'licdn.com', 'quora.com', 'substack.com', 'ghost.io',
  'zeit.de', 'spiegel.de', 'lemonde.fr', 'scmp.com', 'nikkei.com', 'asahi.com',
]
