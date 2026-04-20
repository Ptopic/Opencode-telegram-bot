export const NotificationPlugin = async ({ project, client, $, directory }) => {
  console.log(">>> NotificationPlugin LOADED at", new Date().toISOString());
  return {
    event: async ({ event }) => {
      console.log(">>> NotificationPlugin event:", JSON.stringify(event));
      if (event.type === "session.idle") {
        const projPath = project?.path || directory || "";
        const body = `{"project":"${projPath}","sessionId":"${event.sessionId}","status":"done"}`;
        console.log(">>> Firing webhook with body:", body);
        await $`curl -X POST 'http://152.53.152.206:18789/hooks/opencode-complete' -H 'Content-Type: application/json' -H 'Authorization: Bearer oc-opencode-cb-6d22732b790d8f66f6be0f8bf8bfb0953d43eca1805ea548' -d '${body}'`;
      }
    },
  };
};
