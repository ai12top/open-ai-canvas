import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { Children, cloneElement, isValidElement } from "react";

const dom = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    SVGElement: dom.SVGElement,
    Element: dom.Element,
    Node: dom.Node,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    ShadowRoot: dom.ShadowRoot,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { defaultModelCapabilityConfig } = await import("@/lib/model-capabilities");
const { setActiveUserScope } = await import("@/lib/user-scope");
const { createModelChannel, defaultConfig, useConfigStore } = await import("@/stores/use-config-store");

type CatalogItem = Record<string, any>;
type Protocol = Record<string, any>;
type FetchResult = { models: Array<{ value: string; label: string }>; catalog: CatalogItem[] };

const silent = () => {};
let catalog: CatalogItem[] = [];
let protocols: Protocol[] = [];
let fetchOverride: ((channel: any) => Promise<FetchResult>) | undefined;
let pluginOverride: (() => Promise<Protocol[]>) | undefined;

mock.module("antd", () => {
    const Button = ({ children, icon, loading: _loading, danger: _danger, type: _type, size: _size, ...props }: any) => <button {...props}>{icon}{children}</button>;
    const Input = Object.assign(({ value, onChange, className: _className, prefix: _prefix, ...props }: any) => <input {...props} value={value ?? ""} onChange={onChange} />, { Password: ({ value, onChange, ...props }: any) => <input {...props} type="password" value={value ?? ""} onChange={onChange} /> });
    const Checkbox = ({ children, checked, indeterminate: _indeterminate, ...props }: any) => <label><input type="checkbox" checked={Boolean(checked)} onChange={props.onChange} disabled={props.disabled} aria-label={props["aria-label"]} />{children}</label>;
    const Segmented = ({ options, value, onChange }: any) => <div>{options.map((option: any) => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
    const Popconfirm = ({ children, onConfirm, disabled }: any) => {
        if (!isValidElement(children)) return children;
        const child = Children.only(children) as React.ReactElement<any>;
        return cloneElement(child, { onClick: (event: any) => { child.props.onClick?.(event); if (!disabled) onConfirm?.(); } });
    };
    return {
        App: { useApp: () => ({ message: { info: silent, error: silent, warning: silent, success: silent } }) },
        Alert: ({ description, title }: any) => <div>{title}{description}</div>,
        Button,
        Checkbox,
        Form: Object.assign(({ children }: any) => <form>{children}</form>, { Item: ({ children, label }: any) => <label>{label}{children}</label> }),
        Input,
        Popconfirm,
        Segmented,
        Spin: () => <span>loading</span>,
        Tag: ({ children }: any) => <span>{children}</span>,
    };
});
mock.module("@/components/model-editor-modal", () => ({
    ModelEditorModal: ({ open, title, subtitle, footer, children, items, activeKey }: any) => {
        if (!open) return null;
        const activeItem = items?.find((item: any) => item.key === activeKey) || items?.[0];
        return <section role="dialog" aria-label={typeof title === "string" ? title : "模型编辑"}><h2>{title}</h2><p>{subtitle}</p>{children || activeItem?.children}{footer}</section>;
    },
}));
mock.module("@/components/channel-headers-editor", () => ({ ChannelHeadersEditor: () => null, validateChannelHeaders: () => "" }));
mock.module("@/components/layout/workspace-state", () => ({ WorkspaceState: ({ title }: any) => <div>{title}</div> }));
mock.module("@/components/ui/base/tooltip/ant-tooltip", () => ({ AntTooltip: ({ children }: any) => children }));
mock.module("@/components/ui/base/select", () => ({ Select: ({ value = [], onChange, mode: _mode, ...props }: any) => <select {...props} multiple value={value} onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions).map((item) => item.value))} /> }));
mock.module("@/components/model-protocol-browser", () => ({ ModelProtocolBrowser: ({ onChange }: any) => <button type="button" onClick={() => onChange("browser-image")}>选协议</button> }));
mock.module("@/components/model-capability-editor", () => ({ ModelCapabilityEditor: ({ onChange }: any) => <button type="button" onClick={() => onChange({ image: { default: "updated" } })}>编辑参数</button> }));
mock.module("@/services/api/plugin-catalog", () => ({ fetchPluginProviderCatalog: async () => pluginOverride ? pluginOverride() : protocols }));
mock.module("@/services/api/image-models", () => ({ fetchChannelModels: async (channel: any) => fetchOverride ? fetchOverride(channel) : ({ models: catalog.map((item) => ({ value: item.id, label: item.displayName || item.id })), catalog }), fetchImageModels: async () => [] }));

const { ChannelSettingsPane } = await import("@/pages/settings/channel-settings-pane");

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const rich = (id: string, protocol: string, modelType: "image" | "video" = "image"): CatalogItem => ({
    id,
    displayName: `目录 ${id}`,
    modelType,
    protocol,
    capabilityMeta: { schemaVersion: 1, revision: 4, status: "fresh", sourceVersion: "ui-test", refreshedAt: 1_761_600_000 },
    capabilityConfig: defaultModelCapabilityConfig(protocol, id),
});
const legacy = (id: string): CatalogItem => ({ id, displayName: `旧目录 ${id}`, modelType: "text" });
const protocol = (value: string, capability: "image" | "video", browser = true): Protocol => ({ value, capability, label: value, create: "POST /test", contentType: "application/json", media: "url", ...(browser ? { browserManifest: { version: 1 } } : {}) });
const defaultProtocols = [protocol("browser-image", "image"), protocol("browser-video", "video")];
function cost(model: string, overrides: Record<string, any> = {}) {
    return { model, capability: "image", protocol: "browser-image", billingMode: "fixed_request", unitPriceMicrocredits: 12, capabilityConfig: defaultModelCapabilityConfig("browser-image", model), ...overrides };
}
function channel(models: string[] = [], modelCosts: any[] = [], overrides: Record<string, any> = {}) {
    return createModelChannel({ id: "personal", name: "个人渠道", baseUrl: "http://127.0.0.1:8123/v1", apiKey: "test-key", apiFormat: "openai", models, modelCosts, ...overrides });
}
function setConfig(channels: any[], selected = "") {
    useConfigStore.setState({ config: { ...defaultConfig, channels, models: channels.flatMap((item) => item.models), model: selected, imageModel: selected } });
}
async function mount(initialCatalog: CatalogItem[], initialProtocols = defaultProtocols, fetcher?: (channel: any) => Promise<FetchResult>) {
    catalog = initialCatalog;
    protocols = initialProtocols;
    fetchOverride = fetcher;
    pluginOverride = undefined;
    setActiveUserScope("ui-test-user");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<ChannelSettingsPane onOpenModels={silent} />); await settle(); });
    return {
        host,
        click: async (element: Element | null) => { if (!element) throw new Error("test element not found"); await act(async () => { (element as HTMLElement).click(); await settle(); }); },
        close: async () => { await act(async () => root.unmount()); host.remove(); },
    };
}
function button(host: HTMLElement, label: string) {
    return Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.trim() === label) || null;
}
function checkbox(host: HTMLElement, label: string) {
    const labelled = host.querySelector<HTMLInputElement>(`input[type=checkbox][aria-label="选择 ${label}"]`);
    if (labelled) return labelled;
    const row = Array.from(host.querySelectorAll("label")).find((item) => item.textContent?.includes(label));
    return row?.querySelector("input[type=checkbox]") || null;
}
async function toggleCheckbox(view: Awaited<ReturnType<typeof mount>>, label: string) {
    const item = checkbox(view.host, label);
    if (!item) throw new Error(`checkbox not found: ${label}`);
    await act(async () => { (item as HTMLInputElement).click(); await settle(); });
}
async function changeInput(view: Awaited<ReturnType<typeof mount>>, label: string, value: string) {
    const item = view.host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!item) throw new Error(`input not found: ${label}`);
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
        setter?.call(item, value);
        item.dispatchEvent(new dom.Event("input", { bubbles: true }));
        item.dispatchEvent(new dom.Event("change", { bubbles: true }));
        await settle();
    });
}
function currentChannel() { return useConfigStore.getState().config.channels.find((item) => item.id === "personal")!; }

 test("目录初始无勾选，取消不添加任何模型", async () => {
    setConfig([channel()]);
    const view = await mount([rich("image-one", "browser-image")]);
    try {
        await view.click(button(view.host, "选择添加模型"));
        await settle();
        expect((checkbox(view.host, "目录 image-one") as HTMLInputElement).checked).toBe(false);
        expect(currentChannel().models).toEqual([]);
        await view.click(button(view.host, "取消"));
        expect(currentChannel().models).toEqual([]);
    } finally { await view.close(); }
});

test("搜索与类型筛选保留跨筛选勾选，且只添加明确勾选项", async () => {
    setConfig([channel()]);
    const view = await mount([rich("image-one", "browser-image"), rich("video-one", "browser-video", "video"), legacy("legacy-text")]);
    try {
        await view.click(button(view.host, "选择添加模型"));
        await settle();
        await toggleCheckbox(view, "目录 image-one");
        await changeInput(view, "搜索渠道目录模型", "video-one");
        await toggleCheckbox(view, "目录 video-one");
        expect(view.host.textContent).toContain("已勾选 2 个");
        await view.click(button(view.host, "添加所选模型（2）"));
        const saved = currentChannel();
        expect([...saved.models].sort()).toEqual(["image-one", "video-one"]);
        expect(saved.modelCosts?.map((item) => item.model).sort()).toEqual(["image-one", "video-one"]);
        expect(saved.modelCosts?.find((item) => item.model === "video-one")?.protocol).toBe("browser-video");
        expect(saved.modelCosts?.find((item) => item.model === "image-one")?.capabilityConfig).toEqual(defaultModelCapabilityConfig("browser-image", "image-one"));
        expect(saved.models).not.toContain("legacy-text");
    } finally { await view.close(); }
});

test("已添加模型不可重加，缺协议富目录禁选，旧目录ID仍可添加", async () => {
    setConfig([channel(["existing"], [cost("existing")])]);
    const view = await mount([rich("existing", "browser-image"), rich("missing-protocol", "not-installed"), legacy("legacy-id")]);
    try {
        await view.click(button(view.host, "选择添加模型"));
        await settle();
        expect((checkbox(view.host, "目录 existing") as HTMLInputElement).disabled).toBe(true);
        expect((checkbox(view.host, "目录 missing-protocol") as HTMLInputElement).disabled).toBe(true);
        expect((checkbox(view.host, "旧目录 legacy-id") as HTMLInputElement).disabled).toBe(false);
        await toggleCheckbox(view, "旧目录 legacy-id");
        await view.click(button(view.host, "添加所选模型（1）"));
        expect([...currentChannel().models].sort()).toEqual(["existing", "legacy-id"]);
        expect(currentChannel().modelCosts?.find((item) => item.model === "existing")?.unitPriceMicrocredits).toBe(12);
    } finally { await view.close(); }
});

test("关闭或连接变化后到达的目录响应不回写配置", async () => {
    let resolveFetch!: (value: FetchResult) => void;
    const pendingFetch = () => new Promise<FetchResult>((resolve) => { resolveFetch = resolve; });
    setConfig([channel()]);
    const view = await mount([legacy("late-model")], defaultProtocols, pendingFetch);
    try {
        await view.click(button(view.host, "选择添加模型"));
        await view.click(button(view.host, "取消"));
        resolveFetch({ models: [{ value: "late-model", label: "late-model" }], catalog: [legacy("late-model")] });
        await act(async () => { await settle(); });
        expect(currentChannel().models).toEqual([]);

        await view.click(button(view.host, "选择添加模型"));
        const pending = resolveFetch;
        const latest = currentChannel();
        useConfigStore.getState().replaceConfig({ ...useConfigStore.getState().config, channels: [channel([], [], { ...latest, baseUrl: "http://127.0.0.1:8124/v1" })] });
        await act(async () => { await settle(); });
        pending({ models: [{ value: "late-model", label: "late-model" }], catalog: [legacy("late-model")] });
        await act(async () => { await settle(); });
        expect(currentChannel().models).toEqual([]);
    } finally { await view.close(); }
});

test("更新已有参数不导入新ID，删除进行中的模型不会被迟到结果复活", async () => {
    let resolveFetch!: (value: FetchResult) => void;
    const pendingFetch = () => new Promise<FetchResult>((resolve) => { resolveFetch = resolve; });
    setConfig([channel(["keep", "remove-me"], [cost("keep"), cost("remove-me")])]);
    const view = await mount([rich("keep", "browser-image"), rich("new-id", "browser-image")], defaultProtocols, pendingFetch);
    try {
        await view.click(button(view.host, "更新已有参数"));
        await view.click(button(view.host, "编辑"));
        await toggleCheckbox(view, "remove-me");
        await view.click(button(view.host, "移除所选 (1)"));
        expect(currentChannel().models).toEqual(["keep"]);
        resolveFetch({ models: [{ value: "keep", label: "keep" }, { value: "new-id", label: "new-id" }], catalog: [rich("keep", "browser-image"), rich("new-id", "browser-image")] });
        await act(async () => { await settle(); });
        expect(currentChannel().models).toEqual(["keep"]);
        expect(currentChannel().models).not.toContain("new-id");
    } finally { await view.close(); }
});

test("模型列表搜索后编辑可见模型不会丢失隐藏模型价格", async () => {
    setConfig([channel(["alpha-hidden", "beta-visible"], [cost("alpha-hidden", { unitPriceMicrocredits: 901 }), cost("beta-visible", { unitPriceMicrocredits: 902 })])]);
    const view = await mount([]);
    try {
        await view.click(button(view.host, "编辑"));
        await changeInput(view, "搜索已添加模型", "beta-visible");
        expect(view.host.textContent).not.toContain("alpha-hidden");
        await view.click(button(view.host, "配置使用"));
        await view.click(button(view.host, "视频"));
        const costs = currentChannel().modelCosts || [];
        expect(costs.find((item) => item.model === "alpha-hidden")?.unitPriceMicrocredits).toBe(901);
        expect(costs.find((item) => item.model === "beta-visible")?.capability).toBe("video");
    } finally { await view.close(); }
});

test("批量移除只删除所选模型并将默认模型归一到剩余项", async () => {
    setConfig([channel(["keep-one", "remove-one", "keep-two"], [cost("keep-one"), cost("remove-one"), cost("keep-two")])], "remove-one");
    const view = await mount([]);
    try {
        await view.click(button(view.host, "编辑"));
        await toggleCheckbox(view, "keep-one");
        await toggleCheckbox(view, "remove-one");
        await view.click(button(view.host, "移除所选 (2)"));
        const saved = currentChannel();
        expect(saved.models).toEqual(["keep-two"]);
        expect(saved.modelCosts?.map((item) => item.model)).toEqual(["keep-two"]);
        expect(useConfigStore.getState().config.model).not.toContain("remove-one");
    } finally { await view.close(); }
});

afterAll(() => dom.happyDOM.abort());
