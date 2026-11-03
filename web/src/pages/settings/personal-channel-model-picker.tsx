import { Alert, Button, Checkbox, Input, Segmented, Spin } from "antd";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";

import { ModelEditorModal } from "@/components/model-editor-modal";
import { channelCatalogImportReason, type ChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import { getActiveUserScope } from "@/lib/user-scope";
import { fetchChannelModels } from "@/services/api/image";
import { fetchPluginProviderCatalog } from "@/services/api/plugin-catalog";
import { channelConnectionSignature, type ModelChannel } from "@/stores/use-config-store";

type CatalogFilter = "all" | "image" | "video" | "text" | "audio";
type CatalogSnapshot = {
    userScope: string;
    signature: string;
    catalog: ChannelModelCatalogItem[];
    protocols: ModelProtocolDefinition[];
};

export function PersonalChannelModelPicker({ channel, onClose, onImport }: {
    channel: ModelChannel;
    onClose: () => void;
    onImport: (snapshot: CatalogSnapshot, selectedIds: string[]) => void;
}) {
    const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [keyword, setKeyword] = useState("");
    const [filter, setFilter] = useState<CatalogFilter>("all");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [protocolError, setProtocolError] = useState("");
    const userScope = getActiveUserScope();
    const [attempt, setAttempt] = useState(0);
    const signature = channelConnectionSignature(channel);

    useEffect(() => {
        let active = true;
        setLoading(true);
        setError("");
        setProtocolError("");
        setSnapshot(null);
        setSelectedIds([]);
        void Promise.allSettled([fetchChannelModels(channel, true), fetchPluginProviderCatalog("user.custom-channel")])
            .then(([modelsResult, protocolsResult]) => {
                if (!active || userScope !== getActiveUserScope()) return;
                if (modelsResult.status === "rejected") {
                    const reason: unknown = modelsResult.reason;
                    setError(reason instanceof Error ? reason.message : "模型目录读取失败");
                    return;
                }
                const protocols = protocolsResult.status === "fulfilled" ? protocolsResult.value : [];
                if (protocolsResult.status === "rejected") setProtocolError("影策协议目录读取失败，带能力参数的模型暂不可添加；普通模型 ID 仍可勾选。可重试或在添加后使用原协议窗口配置。");
                const entries = new Map<string, ChannelModelCatalogItem>();
                for (const item of modelsResult.value.catalog) if (!entries.has(item.id)) entries.set(item.id, item);
                setSnapshot({ userScope, signature, catalog: Array.from(entries.values()), protocols });
            })
            .finally(() => { if (active && userScope === getActiveUserScope()) setLoading(false); });
        // 列表和名称变化不重拉目录；连接变化或显式重试会丢弃旧响应和旧勾选。
        return () => { active = false; };
    }, [channel.id, signature, userScope, attempt]);

    const added = new Set(channel.models);
    const currentSnapshot = snapshot?.signature === signature && snapshot.userScope === userScope ? snapshot : null;
    const protocols = currentSnapshot?.protocols || [];
    const query = keyword.trim().toLowerCase();
    const visible = (currentSnapshot?.catalog || []).filter((item) => {
        const protocol = protocols.find((entry) => entry.value === item.protocol);
        return (filter === "all" || item.modelType === filter) && (!query || [item.id, item.displayName, item.protocol, protocol?.label, protocol?.vendor].some((value) => value?.toLowerCase().includes(query)));
    });
    const selectableIds = visible.filter((item) => !added.has(item.id) && !channelCatalogImportReason(item, protocols)).map((item) => item.id);
    const selected = selectedIds.filter((id) => !added.has(id) && currentSnapshot?.catalog.some((item) => item.id === id && !channelCatalogImportReason(item, protocols)));
    const selectedSet = new Set(selected);
    const selectedVisibleCount = selectableIds.filter((id) => selectedSet.has(id)).length;
    const allVisibleSelected = selectableIds.length > 0 && selectedVisibleCount === selectableIds.length;

    return <ModelEditorModal
        open
        title="从渠道目录添加模型"
        subtitle={channel.name}
        onClose={onClose}
        footer={<div className="model-editor-footer">
            <span className="text-xs text-foreground/50">只添加勾选项；已有模型的参数、价格和协议不会改变</span>
            <div className="model-editor-footer-actions">
                <Button onClick={onClose}>取消</Button>
                <Button type="primary" disabled={loading || Boolean(error) || !selected.length || !currentSnapshot} onClick={() => { if (currentSnapshot) onImport(currentSnapshot, selected); }}>添加所选模型（{selected.length}）</Button>
            </div>
        </div>}
    >
        <div className="model-editor-panel space-y-4">
            <p className="text-xs text-foreground/60">读取目录不会自动添加模型。勾选带参数的模型，也会确认其目录声明的已安装协议；添加后仍在影策原有的“配置使用”窗口调整协议与能力。</p>
            {protocolError ? <Alert type="warning" title="部分模型暂不可添加" description={protocolError} action={<Button onClick={() => setAttempt((value) => value + 1)}>重试协议目录</Button>} /> : null}
            <Input allowClear prefix={<Search className="size-4" />} aria-label="搜索渠道目录模型" placeholder="搜索模型名称、ID、协议或来源" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
            <Segmented<CatalogFilter> block value={filter} onChange={setFilter} options={[{ label: "全部", value: "all" }, { label: "图片", value: "image" }, { label: "视频", value: "video" }, { label: "文本", value: "text" }, { label: "音频", value: "audio" }]} />
            {loading ? <div className="py-10 text-center" role="status"><Spin /><p className="mt-3 text-xs text-foreground/55">正在读取模型和影策协议目录…</p></div> : error ? <Alert type="error" title="目录读取失败，个人配置未改动" description={error} action={<Button onClick={() => setAttempt((value) => value + 1)}>重试</Button>} /> : <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground/60">
                    <span aria-live="polite">目录 {currentSnapshot?.catalog.length || 0} 个 · 当前显示 {visible.length} 个 · 已勾选 {selected.length} 个</span>
                    <div className="flex gap-2">
                        <Checkbox aria-label="选择当前可添加模型" disabled={!selectableIds.length} checked={allVisibleSelected} indeterminate={selectedVisibleCount > 0 && !allVisibleSelected} onChange={(event) => setSelectedIds((current) => event.target.checked ? Array.from(new Set([...current, ...selectableIds])) : current.filter((id) => !selectableIds.includes(id)))}>选择当前可添加项</Checkbox>
                        <Button size="small" disabled={!selected.length} onClick={() => setSelectedIds([])}>清空勾选</Button>
                    </div>
                </div>
                <div className="max-h-[min(55vh,520px)] space-y-2 overflow-y-auto">
                    {visible.length ? visible.map((item) => {
                        const exists = added.has(item.id);
                        const reason = channelCatalogImportReason(item, protocols);
                        const protocol = protocols.find((entry) => entry.value === item.protocol);
                        const disabled = exists || Boolean(reason);
                        return <div key={item.id} className="rounded-md border border-border/70 px-3 py-2">
                            <Checkbox className="w-full" disabled={disabled} checked={exists || selectedSet.has(item.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? Array.from(new Set([...current, item.id])) : current.filter((id) => id !== item.id))}>
                                <span className="break-all text-sm font-medium">{item.displayName || item.id}</span>
                                {exists ? <span className="ml-2 text-xs text-foreground/45">已添加</span> : null}
                            </Checkbox>
                            <div className="mt-1 space-y-1 pl-6 text-xs text-foreground/55">
                                {item.displayName && item.displayName !== item.id ? <div className="break-all font-mono">{item.id}</div> : null}
                                <div className="break-all">{item.modelType ? capabilityLabel(item.modelType) : "未声明类型"} · {protocol ? `${protocol.vendor ? `${protocol.vendor} · ` : ""}${protocol.label}` : item.protocol || "添加后在“配置使用”中选择协议"}</div>
                                {!exists && reason ? <div className="text-foreground/70">不可自动添加：{reason}</div> : null}
                            </div>
                        </div>;
                    }) : <p className="py-8 text-center text-sm text-foreground/50">{currentSnapshot?.catalog.length ? "没有匹配的模型，请调整搜索或类型筛选" : "渠道未返回模型；可关闭窗口后手动输入模型 ID"}</p>}
                </div>
            </>}
        </div>
    </ModelEditorModal>;
}

function capabilityLabel(value: NonNullable<ChannelModelCatalogItem["modelType"]>) {
    return { image: "图片", video: "视频", text: "文本", audio: "音频" }[value];
}
