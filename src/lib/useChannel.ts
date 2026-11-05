import { useEffect, useState } from 'react';
import { api, type Channel } from './api';

/** Channel + the current user's role in it (UI hints only; the API enforces). */
export function useChannel(channelId: string | undefined) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (channelId) api<Channel>('GET', `/channels/${channelId}`).then(setChannel).catch(() => setChannel(null)).finally(() => setReady(true));
  }, [channelId]);
  return { channel, role: channel?.my_role ?? null, ready };
}
