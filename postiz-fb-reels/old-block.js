        else if ((0, has_extension_1.hasExtension)(firstPost?.media?.[0]?.path, 'mp4')) {
            const { id: videoId, permalink_url, ...all } = await (await this.fetch(`https://graph.facebook.com/v20.0/${id}/videos?access_token=${accessToken}&fields=id,permalink_url`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    file_url: firstPost?.media?.[0]?.path,
                    description: firstPost.message,
                    published: true,
                }),
            }, 'upload mp4')).json();
            finalUrl = 'https://www.facebook.com/reel/' + videoId;
            finalId = videoId;
        }
