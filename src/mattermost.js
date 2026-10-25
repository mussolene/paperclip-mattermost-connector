export function createMattermostClient({ baseUrl, token, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/+$/, "");

  async function request(path, init = {}) {
    const headers = { Authorization: `Bearer ${token}`, ...init.headers };
    if (!(init.body instanceof FormData) && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(`${root}/api/v4${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      headers
    });
    if (!response.ok) {
      const error = new Error("Mattermost API request failed");
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  let actor;
  async function setPostStatus(postId, status) {
    const names = { processing: "hourglass_flowing_sand", success: "white_check_mark", error: "warning" };
    const emojiName = names[status];
    if (!emojiName) throw new Error("Unknown Mattermost request status");
    actor ??= request("/users/me");
    const user = await actor;
    const reactions = await request(`/posts/${encodeURIComponent(postId)}/reactions`);
    const own = (reactions ?? []).filter((reaction) => reaction.user_id === user.id);
    if (!own.some((reaction) => reaction.emoji_name === emojiName)) {
      await request("/reactions", { method: "POST", body: JSON.stringify({ user_id: user.id, post_id: postId, emoji_name: emojiName }) });
    }
    for (const reaction of own) {
      if (Object.values(names).includes(reaction.emoji_name) && reaction.emoji_name !== emojiName) {
        await request(`/users/${encodeURIComponent(user.id)}/posts/${encodeURIComponent(postId)}/reactions/${encodeURIComponent(reaction.emoji_name)}`, { method: "DELETE" });
      }
    }
  }

  async function requestImage(path, maxBytes = 1024 * 1024) {
    const response = await fetchImpl(`${root}/api/v4${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const error = new Error("Mattermost API request failed");
      error.status = response.status;
      throw error;
    }
    const contentLength = Number(response.headers?.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      throw new Error("Mattermost team icon exceeds the 1 MiB limit");
    }
    if (!response.body?.getReader) throw new Error("Mattermost team icon response has no readable body");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Mattermost team icon exceeds the 1 MiB limit");
      }
      chunks.push(Buffer.from(value));
    }
    return { data: Buffer.concat(chunks, total), contentType: response.headers?.get("content-type") ?? "application/octet-stream" };
  }

  return {
    setPostStatus,
    async latestPostId(channelId) {
      const result = await request(`/channels/${encodeURIComponent(channelId)}/posts?page=0&per_page=1`);
      return result.order?.[0] ?? null;
    },
    async postsAfter(channelId, postId, page = 0) {
      const query = new URLSearchParams({ after: postId, page: String(page), per_page: "200" });
      const result = await request(`/channels/${encodeURIComponent(channelId)}/posts?${query}`);
      const posts = (result.order ?? []).map((id) => result.posts?.[id]).filter(Boolean).sort((a, b) => a.create_at - b.create_at || a.id.localeCompare(b.id));
      return { posts, hasNext: Boolean(result.next_post_id) || result.has_next === true };
    },
    async postsSince(channelId, timestamp) {
      const query = new URLSearchParams({ since: String(timestamp) });
      const result = await request(`/channels/${encodeURIComponent(channelId)}/posts?${query}`);
      return (result.order ?? []).map((id) => result.posts?.[id]).filter(Boolean).sort((a, b) => a.create_at - b.create_at);
    },
    async getThread(postId) {
      return request(`/posts/${encodeURIComponent(postId)}/thread`);
    },
    async createReply({ channelId, rootId, text, deliveryKey, issueId, agentId }) {
      return request("/posts", {
        method: "POST",
        body: JSON.stringify({
          channel_id: channelId,
          root_id: rootId,
          message: text,
          props: { paperclip_delivery_key: deliveryKey, paperclip_issue_id: issueId, ...(agentId ? { paperclip_agent_id: agentId } : {}) }
        })
      });
    },
    async getMe() {
      return request("/users/me");
    },
    async getTeamIcon(teamId) {
      return requestImage("/teams/" + encodeURIComponent(teamId) + "/image");
    },
    async setUserProfileImage(userId, image) {
      const mime = image.contentType.split(";")[0].trim().toLowerCase();
      const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/bmp": "bmp" })[mime] ?? "png";
      const body = new FormData();
      body.append("image", new Blob([image.data], { type: mime }), "profile." + extension);
      return request("/users/" + encodeURIComponent(userId) + "/image", { method: "POST", body });
    },
    async getUserByUsername(username) {
      return request("/users/username/" + encodeURIComponent(username));
    },
    async getBot(userId) {
      return request("/bots/" + encodeURIComponent(userId));
    },
    async createBot(bot) {
      return request("/bots", { method: "POST", body: JSON.stringify(bot) });
    },
    async patchBot(userId, changes) {
      return request("/bots/" + encodeURIComponent(userId), { method: "PUT", body: JSON.stringify(changes) });
    },
    async getTeamMember(teamId, userId) {
      return request("/teams/" + encodeURIComponent(teamId) + "/members/" + encodeURIComponent(userId));
    },
    async addTeamMember(teamId, userId) {
      return request("/teams/" + encodeURIComponent(teamId) + "/members", { method: "POST", body: JSON.stringify({ team_id: teamId, user_id: userId }) });
    },
    async getChannelMember(channelId, userId) {
      return request("/channels/" + encodeURIComponent(channelId) + "/members/" + encodeURIComponent(userId));
    },
    async addChannelMember(channelId, userId) {
      return request("/channels/" + encodeURIComponent(channelId) + "/members", { method: "POST", body: JSON.stringify({ user_id: userId }) });
    },
    async listUserTokens(userId) {
      const all = [];
      for (let page = 0; ; page += 1) {
        const batch = await request("/users/" + encodeURIComponent(userId) + "/tokens?page=" + page + "&per_page=200");
        all.push(...batch);
        if (batch.length < 200) break;
      }
      return all;
    },
    async createUserToken(userId, description) {
      return request("/users/" + encodeURIComponent(userId) + "/tokens", { method: "POST", body: JSON.stringify({ description }) });
    },
    async revokeUserToken(tokenId) {
      return request("/users/tokens/revoke", { method: "POST", body: JSON.stringify({ token_id: tokenId }) });
    }
  };
}
