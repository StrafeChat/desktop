import { Client } from "discord-rpc";
export var rpc: Client;

export async function connectRPC() {

    try {
        rpc = new Client({ transport: "ipc" });

        rpc.on("ready", () =>
            rpc.setActivity({
                state: "strafe.chat",
                details: "Exploring the world of StrafeChat",
                largeImageKey: "strafechat",
                largeImageText: "StrafeChat",
                buttons: [
                    {
                        label: "Join Early Alpha",
                        url: "https://strafe.chat/",
                    },
                ],
            }),
        );

        rpc.on("disconnected", reconnect);

        rpc.login({ clientId: "1160242168393388132" });
    } catch (err) {
        reconnect();
    }
}

const reconnect = () => setTimeout(() => connectRPC(), 1e4);

export async function dropRPC() {
    rpc?.destroy();
}