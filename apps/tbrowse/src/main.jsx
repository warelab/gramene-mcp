// MCP App view for gramene-mcp: the tbrowse gene-tree viewer.
//
// The host renders this page in a sandboxed iframe when the model calls the
// `gene_tree_view` tool. The tool result's `structuredContent` names the site's
// REST base and the gene / tree to show; the tree, alignment, neighbourhoods
// and gene structures are then fetched straight from that Gramene API by
// tbrowse-core's `grameneGeneTreeSource` (the same loader gramene-search's
// Homology panel runs). The API origin is allowed through the resource's
// `_meta.ui.csp.connectDomains`, set by server.mjs.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useApp,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps/react';
import {
  TBrowse,
  createGenomeZone,
  labelsZone,
  msaZone,
  neighborhoodZone,
  treeZone,
  useInitialViewState,
  useLoader,
} from 'tbrowse';
import { grameneGeneTreeSource } from 'tbrowse-core';

const APP_INFO = { name: 'gramene-tbrowse', version: '0.1.0' };
const INLINE_HEIGHT = 620;

const genomeZone = createGenomeZone({ id: 'genome', displayName: 'Gene structure' });
const ZONES = [treeZone, labelsZone, msaZone, neighborhoodZone, genomeZone];
// Which loader slots feed which zone, so each zone's header shows its own
// loading / error state.
const ZONE_SLOTS = { neighborhood: ['neighborhood'], genome: ['geneStructures'] };

/** `{ site, apiBase, geneId?, treeId }` from a gene_tree_view result, or an error string. */
function targetFromResult(result) {
  const textOf = () => (result?.content ?? []).find((c) => c.type === 'text')?.text;
  if (result?.isError) return { error: textOf() || 'The gene_tree_view tool failed.' };
  let data = result?.structuredContent;
  if (!data) {
    // A host that drops structuredContent still forwards the text block,
    // which carries the same JSON.
    try { data = JSON.parse(textOf() ?? ''); } catch { data = null; }
  }
  if (!data || typeof data.apiBase !== 'string' || !(data.treeId || data.geneId)) {
    return { error: 'The tool result did not name a gene tree to display.' };
  }
  return { target: data };
}

function Message({ children, tone }) {
  return (
    <div
      style={{
        padding: '24px 16px',
        textAlign: 'center',
        color: tone === 'error'
          ? 'var(--color-text-danger, #b42318)'
          : 'var(--color-text-secondary, #666)',
      }}
    >
      {children}
    </div>
  );
}

function Viewer({ app, target, theme, height, fullscreen, canFullscreen }) {
  const ctx = useMemo(
    () => ({
      base: target.apiBase,
      ...(target.geneId ? { geneId: target.geneId } : {}),
      ...(target.treeId ? { treeId: target.treeId } : {}),
      ...(target.treeField ? { treeField: target.treeField } : {}),
    }),
    [target],
  );
  const { snapshot, hostProps } = useLoader(grameneGeneTreeSource, ctx, {
    key: [ctx.base, ctx.treeId ?? '', ctx.geneId ?? ''],
    zoneSlots: ZONE_SLOTS,
  });
  const [viewState, setViewState] = useInitialViewState(ZONES, snapshot);

  const toggleFullscreen = useCallback(() => {
    app.requestDisplayMode({ mode: fullscreen ? 'inline' : 'fullscreen' }).catch(() => {});
  }, [app, fullscreen]);

  // Tooltip button on a leaf: hand the gene back to the conversation.
  const nodeActions = useCallback(
    (node) => {
      if (!node.isLeaf || !node.geneId) return null;
      return [
        {
          label: 'Ask about this gene',
          title: `Send ${node.geneId} to the conversation`,
          onClick: () => {
            app
              .sendMessage({
                role: 'user',
                content: [{
                  type: 'text',
                  text: `Tell me about gene ${node.geneId} (from the ${target.site} gene tree ${snapshot.root?.meta?.treeId ?? target.treeId ?? ''}).`,
                }],
              })
              .catch(() => {});
          },
        },
      ];
    },
    [app, target, snapshot.root],
  );

  if (!hostProps || !viewState) {
    return snapshot.error
      ? <Message tone="error">Could not load the gene tree from {target.apiBase}: {snapshot.error}</Message>
      : <Message>Loading gene tree{target.treeId ? ` ${target.treeId}` : ''} from {target.site}…</Message>;
  }

  return (
    <div style={{ height, width: '100%' }}>
      <TBrowse
        {...hostProps}
        zones={ZONES}
        viewState={viewState}
        onViewStateChange={setViewState}
        theme={theme}
        densityControls
        nodeActions={nodeActions}
        headerActions={
          canFullscreen ? (
            <button type="button" onClick={toggleFullscreen} style={{ font: 'inherit', cursor: 'pointer' }}>
              {fullscreen ? 'Exit full screen' : 'Full screen'}
            </button>
          ) : null
        }
      />
    </div>
  );
}

function GeneTreeApp() {
  const [state, setState] = useState({ target: null, error: null });
  const [hostContext, setHostContext] = useState(null);

  const { app, isConnected, error: connectError } = useApp({
    appInfo: APP_INFO,
    capabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    onAppCreated: (a) => {
      a.ontoolresult = (result) => {
        const { target, error } = targetFromResult(result);
        setState({ target: target ?? null, error: error ?? null });
      };
      a.ontoolcancelled = () => setState({ target: null, error: 'The tool call was cancelled.' });
      a.onhostcontextchanged = (patch) => setHostContext((prev) => ({ ...prev, ...patch }));
      a.onteardown = async () => ({});
    },
  });

  useEffect(() => {
    if (isConnected && app) setHostContext(app.getHostContext() ?? {});
  }, [isConnected, app]);

  // Follow the host's look: colour scheme, CSS variables and fonts.
  useEffect(() => {
    if (!hostContext) return;
    if (hostContext.theme) applyDocumentTheme(hostContext.theme);
    if (hostContext.styles?.variables) applyHostStyleVariables(hostContext.styles.variables);
    if (hostContext.styles?.css?.fonts) applyHostFonts(hostContext.styles.css.fonts);
  }, [hostContext]);

  if (connectError) return <Message tone="error">Could not connect to the host: {connectError.message}</Message>;
  if (!isConnected || !app) return <Message>Connecting…</Message>;
  if (state.error) return <Message tone="error">{state.error}</Message>;
  if (!state.target) return <Message>Waiting for the gene tree…</Message>;

  const fullscreen = hostContext?.displayMode === 'fullscreen';
  const dims = hostContext?.containerDimensions ?? {};
  // Fullscreen (or a host that fixes the frame height): fill the frame.
  // Inline: tbrowse scrolls internally, so give it a fixed height the SDK's
  // auto-resize then reports to the host.
  const height = fullscreen || typeof dims.height === 'number'
    ? '100vh'
    : Math.min(INLINE_HEIGHT, typeof dims.maxHeight === 'number' ? dims.maxHeight : INLINE_HEIGHT);
  const canFullscreen = (hostContext?.availableDisplayModes ?? []).includes('fullscreen');

  return (
    <Viewer
      app={app}
      target={state.target}
      theme={hostContext?.theme === 'dark' ? 'dark' : 'light'}
      height={height}
      fullscreen={fullscreen}
      canFullscreen={canFullscreen}
    />
  );
}

createRoot(document.getElementById('root')).render(<GeneTreeApp />);
