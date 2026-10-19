/**
 * Lecture, auprès du content script de X/Twitter, des vidéos présentes dans le DOM (média + tweet)
 * pour libeller les flux sniffés dans la popup. Sans effet hors X/Twitter.
 */

import type { GetTweetVideosMessage } from '@/src/lib/messaging';
import { sanitizeTweetVideos } from '@/src/lib/tweetSource';
import { isTwitterUrl, type TweetVideoInfo } from '@/src/lib/twitterMedia';

export async function requestTweetVideos(tabId: number, tabUrl: string): Promise<TweetVideoInfo[]> {
  if (!isTwitterUrl(tabUrl)) return [];
  try {
    const message: GetTweetVideosMessage = { type: 'GET_TWEET_VIDEOS' };
    return sanitizeTweetVideos(await browser.tabs.sendMessage(tabId, message));
  } catch {
    // Pas de content script (page non rechargée après installation) : on retombe sur le probe.
    return [];
  }
}
