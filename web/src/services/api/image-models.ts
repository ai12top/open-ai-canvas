import { sanitizeChannelModelCatalogItem, type ChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import { browserPluginModelAuthHeaders } from "@/services/api/browser-plugin";
import { createChannelTransport } from "@/services/api/channel-transport";
import { readAxiosError, validateGeminiPayload } from "@/services/api/image-response";
import { geminiApiUrl, geminiHeaders } from "@/services/api/image-transport";
import { http } from "@/services/api/request";
import { buildApiUrl, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};

type GeminiModelPayload = { models?: Array<{ name?: string }> };
type OpenAIModelPayload = { data?: Array<{ id?: string } & Record<string, unknown>>; error?: { message?: string } };

/**
 * 读取图片/视频渠道的模型目录。
 *
 * 个人渠道的声明式插件会把带能力声明的富条目（modelType/protocol/capabilityConfig/
 * capabilityMeta）原样带回来，这里只做结构收窄，不丢字段、不推断协议；普通 OpenAI/Gemini
 * 目录返回的依旧只有 id。
 */
export async function fetchImageModelCatalog(
    config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "channelScope" | "headers" | "interfaceType">,
): Promise<ChannelModelCatalogItem[]> {
    try {
        if (config.apiFormat === "gemini") {
            const requestConfig = { ...defaultGeminiConfig, ...config };
            const payload = await createChannelTransport(requestConfig, "image").get<GeminiModelPayload>(geminiApiUrl(requestConfig), { headers: geminiHeaders(requestConfig) });
            validateGeminiPayload(payload);
            return (payload.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .map((id) => ({ id }));
        }
        // 个人渠道的声明式插件协议（图片或视频）按 manifest 放行 /models，鉴权头由共享 Go 规则生成，
        // 同名插件优先于内置协议名；未安装的未知协议直接报错，系统渠道与 Gemini 不查插件目录。
        const pluginHeaders = config.channelScope === "user" && config.apiFormat === "openai" ? await browserPluginModelAuthHeaders(config) : undefined;
        const transportConfig = pluginHeaders ? { ...config, declarativePlugin: true } : config;
        const payload = await createChannelTransport(transportConfig, "image").get<OpenAIModelPayload>(
            buildApiUrl(config.baseUrl, "/models"),
            pluginHeaders ? { headers: pluginHeaders } : undefined,
        );
        return sanitizeModelDirectory(payload.data);
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "channelScope" | "headers" | "interfaceType">) {
    const catalog = await fetchImageModelCatalog(config);
    return catalog.map((item) => item.id).sort((a, b) => a.localeCompare(b));
}

/** 富条目按 id 去重保首个；结构不合法的条目只丢自己的富字段，不连坐整份目录。 */
function sanitizeModelDirectory(data: Array<{ id?: string } & Record<string, unknown>> | undefined): ChannelModelCatalogItem[] {
    const catalog = new Map<string, ChannelModelCatalogItem>();
    for (const entry of data || []) {
        const item = sanitizeChannelModelCatalogItem(entry);
        if (!item || catalog.has(item.id)) continue;
        catalog.set(item.id, item);
    }
    return Array.from(catalog.values());
}

export type ChannelModelFetchResult = { models: string[]; catalog: ChannelModelCatalogItem[] };

export async function fetchChannelModels(channel: ModelChannel, viaBackend = false): Promise<ChannelModelFetchResult> {
    if (!viaBackend || channel.scope !== "system") {
        // 个人插件路径保留网关原始富条目；普通目录天然只有 id，行为与之前一致。
        const catalog = await fetchImageModelCatalog({
            baseUrl: channel.baseUrl,
            apiKey: channel.apiKey,
            apiFormat: channel.apiFormat,
            headers: channel.headers,
            interfaceType: channel.interfaceType,
            channelScope: channel.scope === "system" ? "system" : "user",
        });
        const sorted = [...catalog].sort((a, b) => a.id.localeCompare(b.id));
        return { models: sorted.map((item) => item.id), catalog: sorted };
    }
    try {
        // 登录态由同源后端代取模型目录，避免每个 OpenAI 兼容服务分别维护浏览器 CORS 白名单。
        const result = await http.post<{ models?: Array<string | ChannelModelCatalogItem> }>("/ai/models", {
            baseUrl: channel.baseUrl,
            apiKey: channel.apiKey,
            apiFormat: channel.apiFormat,
            headers: channel.headers,
        });
        const catalog = new Map<string, ChannelModelCatalogItem>();
        for (const item of result.models || []) {
            const entry = typeof item === "string" ? sanitizeChannelModelCatalogItem({ id: item }) : sanitizeChannelModelCatalogItem(item);
            if (!entry) continue;
            const existing = catalog.get(entry.id);
            catalog.set(entry.id, existing || entry);
        }
        const models = Array.from(catalog.keys()).sort((a, b) => a.localeCompare(b));
        const sortedCatalog = Array.from(catalog.values()).sort((a, b) => a.id.localeCompare(b.id));
        return { models, catalog: sortedCatalog };
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}
