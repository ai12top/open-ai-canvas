import { http } from "@/services/api/request";
import type { ModelProtocolDefinition, ProtocolCapability } from "@/lib/model-protocols";

export type PluginProviderCatalogItem = {
    imageParameters?: import("@/lib/image-parameters").ImageParameter[];
    id: string;
    version: string;
    name: string;
    vendor: string;
    categories: string[];
    scopes: string[];
    create?: string;
    poll?: string;
    contentType?: string;
    enabled: boolean;
    unavailableReason?: string;
    baseUrl?: string;
    /** 浏览器可执行声明式插件的原始 manifest；仅表示协议资格，不代表上游 CORS 可达。 */
    browserManifest?: Record<string, unknown>;
    browserUnsupportedReason?: string;
    parameters?: Array<{
        name: string;
        type: string;
        required?: boolean;
        description?: string;
        values?: string[];
        mapping?: string;
    }>;
    workflows?: Array<{
        id: string;
        label: string;
        providerId: string;
        capability: ProtocolCapability;
        parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; mapping?: string }>;
        defaults?: Record<string, string | number | boolean>;
    }>;
};

export async function fetchPluginProviderCatalog(scope: string, capability?: ProtocolCapability) {
    const result = await http.get<{ providers: PluginProviderCatalogItem[] }>("/plugins/catalog", { params: { scope, capability } });
    return result.providers.filter((item) => item.enabled && !item.unavailableReason).map(toProviderDefinition);
}

function toProviderDefinition(item: PluginProviderCatalogItem): ModelProtocolDefinition {
    return {
        value: item.id,
        label: item.name,
        vendor: item.vendor,
        capability: (item.categories[0] || "text") as ProtocolCapability,
        create: item.create || "",
        poll: item.poll,
        contentType: item.contentType || "application/json",
        media: `${item.vendor} · ${item.version}`,
        enabled: item.enabled && !item.unavailableReason,
        baseUrl: item.baseUrl,
        parameters: item.parameters || [],
        imageParameters: item.imageParameters,
        workflows: item.workflows || [],
        browserManifest: item.browserManifest,
        browserUnsupportedReason: item.browserUnsupportedReason,
    };
}
