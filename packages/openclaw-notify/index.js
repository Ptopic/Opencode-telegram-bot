export const NotificationPlugin = async ({ project, client, $, directory }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle" && event.sessionId) {
        const projPath = project?.path || directory || "";
        const payload = JSON.stringify({
          project: projPath,
          sessionId: event.sessionId,
          status: "done"
        });
        await $`curl -X POST 'http://152.53.152.206:18789/hooks/opencode-complete' -H 'Content-Type: application/json' -H 'Authorization: Bearer oc-opencode-cb-6d22732b790d8f66f6be0f8bf8bfb0953d43eca1805ea548' -d "` + payload + `"`;
      }
    },
  };
};
