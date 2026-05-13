import { z } from "zod";
import { execCommand } from "../lib/ssh-client.js";
import { resolveServer } from "./registry.js";
import { defineTool, type ToolDef } from "./registry-core.js";

export function getDeployTools(): ToolDef[] {
  return [
    defineTool({
      name: "docker_ps",
      category: "deploy",
      summary: "List Docker containers (running and stopped) on a VPS",
      description: "List Docker containers on a VPS server (running and stopped).",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        all: z.boolean().default(true).describe("Show all containers (including stopped). Default: true"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          await extra.sendLog(`[${args.server}] docker ps`);
          const flag = args.all ? "-a" : "";
          const result = await execCommand(
            record,
            `docker ps ${flag} --format '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","ports":"{{.Ports}}"}'`
          );

          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `Error (exit ${result.exitCode}):\n${result.stderr}` }],
              isError: true,
            };
          }

          const containers = result.stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return { raw: line };
              }
            });

          return {
            content: [{ type: "text", text: JSON.stringify(containers, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    }),

    defineTool({
      name: "docker_compose",
      category: "deploy",
      summary: "Run a docker compose action (up/down/restart/pull/logs/ps/build) on a VPS",
      description:
        "Run a docker compose command (up/down/restart/pull/logs/ps) in a directory on a VPS server.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        path: z.string().min(1).describe("Absolute path to the directory containing docker-compose.yml"),
        action: z
          .enum(["up", "down", "restart", "pull", "logs", "ps", "build"])
          .describe("Docker compose action to run"),
        service: z.string().optional().describe("Optional: target a specific service name"),
        flags: z
          .string()
          .optional()
          .describe("Optional: extra flags (e.g. '--detach' for up, '--tail=100' for logs)"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          const service = args.service ?? "";
          const flags = args.flags ?? "";
          await extra.sendLog(
            `[${args.server}] docker compose ${args.action}${service ? ` ${service}` : ""}`
          );

          const actionMap: Record<string, string> = {
            up: "up --detach",
            down: "down",
            restart: "restart",
            pull: "pull",
            logs: "logs --tail=200",
            ps: "ps",
            build: "build",
          };

          const baseAction = actionMap[args.action];
          const cmd = `cd '${args.path}' && docker compose ${baseAction} ${flags} ${service}`.trim();
          const result = await execCommand(record, cmd);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
                  null,
                  2
                ),
              },
            ],
            isError: result.exitCode !== 0,
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    }),

    defineTool({
      name: "docker_exec",
      category: "deploy",
      summary: "Execute a command inside a running Docker container on a VPS",
      description: "Execute a command inside a running Docker container on a VPS server.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        container: z.string().min(1).describe("Container name or ID"),
        command: z.string().min(1).describe("Command to run inside the container"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          await extra.sendLog(`[${args.server}] docker exec ${args.container}: ${args.command}`);
          const result = await execCommand(
            record,
            `docker exec ${args.container} sh -c '${args.command.replace(/'/g, "'\\''")}'`
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
                  null,
                  2
                ),
              },
            ],
            isError: result.exitCode !== 0,
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    }),

    defineTool({
      name: "deploy_app",
      category: "deploy",
      summary: "Deploy an app: git pull → optional build → optional restart",
      description:
        "Deploy an application on a VPS: git pull → optional build → restart service/container.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        path: z.string().min(1).describe("Absolute path to the application directory"),
        branch: z.string().default("main").describe("Git branch to pull"),
        buildCommand: z
          .string()
          .optional()
          .describe("Build command to run after pull (e.g. 'npm run build' or 'docker compose build')"),
        restartCommand: z
          .string()
          .optional()
          .describe("Restart command (e.g. 'docker compose up -d' or 'systemctl restart myapp')"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          const steps: Array<{
            step: string;
            result: { stdout: string; stderr: string; exitCode: number | null };
          }> = [];
          const totalSteps = 1 + (args.buildCommand ? 1 : 0) + (args.restartCommand ? 1 : 0);
          await extra.sendLog(
            `[${args.server}] Deploying ${args.path} (${totalSteps} step${totalSteps > 1 ? "s" : ""})...`
          );

          await extra.sendLog(`[${args.server}] Step 1/${totalSteps}: git pull (${args.branch})`);
          const pullResult = await execCommand(
            record,
            `cd '${args.path}' && git fetch origin && git checkout '${args.branch}' && git pull origin '${args.branch}'`
          );
          steps.push({ step: "git pull", result: pullResult });

          if (pullResult.exitCode !== 0) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error: "git pull failed", steps }, null, 2),
                },
              ],
              isError: true,
            };
          }

          if (args.buildCommand) {
            const buildStep = 2;
            await extra.sendLog(
              `[${args.server}] Step ${buildStep}/${totalSteps}: build — ${args.buildCommand}`
            );
            const buildResult = await execCommand(
              record,
              `cd '${args.path}' && ${args.buildCommand}`
            );
            steps.push({ step: "build", result: buildResult });

            if (buildResult.exitCode !== 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ error: "build failed", steps }, null, 2),
                  },
                ],
                isError: true,
              };
            }
          }

          if (args.restartCommand) {
            await extra.sendLog(
              `[${args.server}] Step ${totalSteps}/${totalSteps}: restart — ${args.restartCommand}`
            );
            const restartResult = await execCommand(
              record,
              `cd '${args.path}' && ${args.restartCommand}`
            );
            steps.push({ step: "restart", result: restartResult });
          }

          return {
            content: [
              { type: "text", text: JSON.stringify({ success: true, steps }, null, 2) },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    }),
  ];
}
