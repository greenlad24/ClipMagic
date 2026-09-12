        else if ((0, has_extension_1.hasExtension)(firstPost?.media?.[0]?.path, 'mp4')) {
            // [fb-reels-patch] Publish through the Reels API so video_state is explicit,
            // falling back to /videos for anything Facebook will not accept as a reel.
            const reelSource = firstPost?.media?.[0]?.path;
            let videoId = '';
            let reelPhase = 'start';
            try {
                const startPhase = await (await this.fetch(`https://graph.facebook.com/v20.0/${id}/video_reels?upload_phase=start&access_token=${accessToken}`, {
                    method: 'POST',
                }, 'start reel upload')).json();
                videoId = startPhase?.video_id || '';
                if (!videoId || !startPhase?.upload_url) {
                    throw new Error('video_reels start returned no upload target');
                }
                reelPhase = 'upload';
                await this.fetch(startPhase.upload_url, {
                    method: 'POST',
                    headers: {
                        Authorization: `OAuth ${accessToken}`,
                        file_url: reelSource,
                    },
                }, 'upload reel');
                // Wait for the UPLOADING phase only. Facebook does not start
                // processing/publishing until upload_phase=finish, so video_status is
                // pinned at "upload_complete" and processing_phase at "not_started"
                // until then - waiting for "ready" here can never succeed.
                reelPhase = 'upload-wait';
                let uploaded = false;
                let reelWaits = 0;
                while (!uploaded) {
                    const { status } = await (await this.fetch(`https://graph.facebook.com/v20.0/${videoId}?fields=status&access_token=${accessToken}`, undefined, '', 0, true)).json();
                    if (status?.uploading_phase?.status === 'error' ||
                        status?.video_status === 'error') {
                        throw new Error('reel upload failed');
                    }
                    uploaded = status?.uploading_phase?.status === 'complete';
                    if (!uploaded) {
                        if (++reelWaits > 40) {
                            throw new Error('reel upload timed out');
                        }
                        await (0, timer_1.timer)(10000);
                    }
                }
                reelPhase = 'finish';
                await this.fetch(`https://graph.facebook.com/v20.0/${id}/video_reels?upload_phase=finish&video_id=${videoId}&video_state=PUBLISHED&description=${encodeURIComponent(firstPost.message || '')}&access_token=${accessToken}`, {
                    method: 'POST',
                }, 'publish reel');
                reelPhase = 'done';
            }
            catch (err) {
                // Never mask a dead token, and never re-post once the reel reached the
                // finish phase - that would duplicate the video. Everything before
                // finish leaves an unpublished draft, so falling back is safe there.
                if (err?.type === 'refresh_token' ||
                    reelPhase === 'finish' ||
                    reelPhase === 'done') {
                    throw err;
                }
                const { id: fallbackId } = await (await this.fetch(`https://graph.facebook.com/v20.0/${id}/videos?access_token=${accessToken}&fields=id,permalink_url`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        file_url: reelSource,
                        description: firstPost.message,
                        published: true,
                    }),
                }, 'upload mp4')).json();
                videoId = fallbackId;
            }
            finalId = videoId;
            finalUrl = `https://www.facebook.com/${videoId}`;
            // Facebook only exposes permalink_url once publishing has progressed, so
            // give it a few seconds. A published post must not fail just because the
            // URL could not be read back.
            for (let reelUrlTry = 0; reelUrlTry < 6; reelUrlTry++) {
                try {
                    const { permalink_url: reelPermalink } = await (await this.fetch(`https://graph.facebook.com/v20.0/${videoId}?fields=permalink_url&access_token=${accessToken}`, undefined, '', 0, true)).json();
                    if (reelPermalink) {
                        finalUrl = reelPermalink.startsWith('http')
                            ? reelPermalink
                            : `https://www.facebook.com${reelPermalink}`;
                        break;
                    }
                }
                catch (err) { }
                await (0, timer_1.timer)(5000);
            }
        }
