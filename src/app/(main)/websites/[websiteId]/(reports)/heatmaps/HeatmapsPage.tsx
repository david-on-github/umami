'use client';
import { Button, Column, Row, SearchField } from '@umami/react-zen';
import { useState } from 'react';
import { WebsiteControls } from '@/app/(main)/websites/[websiteId]/WebsiteControls';
import { EmptyPlaceholder } from '@/components/common/EmptyPlaceholder';
import { Panel } from '@/components/common/Panel';
import { useMessages, useMobile, useSubscription, useWebsite } from '@/components/hooks';
import { Flame } from '@/components/icons';
import { FilterButtons } from '@/components/input/FilterButtons';
import type { HeatmapMode } from '@/queries/sql';
import { Heatmap, type HeatmapSelection } from './Heatmap';
import styles from './Heatmap.module.css';

const EMPTY_SELECTION: HeatmapSelection = { urlPath: '', hostname: '' };

export function HeatmapsPage({ websiteId }: { websiteId: string }) {
  const [selectionByMode, setSelectionByMode] = useState<Record<HeatmapMode, HeatmapSelection>>({
    click: EMPTY_SELECTION,
    scroll: EMPTY_SELECTION,
  });
  const [mode, setMode] = useState<HeatmapMode>('click');
  const [search, setSearch] = useState('');
  const { isPhone } = useMobile();
  const website = useWebsite();
  const { t, labels, messages } = useMessages();
  const { hasFeature, cloudMode } = useSubscription(website?.teamId);

  const buttons = [
    { id: 'click', label: 'Clicks' },
    { id: 'scroll', label: 'Scroll' },
  ];

  if (cloudMode && !hasFeature('replays')) {
    return (
      <Column gap="3">
        <Panel>
          <EmptyPlaceholder
            icon={<Flame />}
            title={t(messages.upgradeRequired, { plan: 'Business' })}
            description="View click and scroll heatmaps for your pages."
          >
            <Button
              variant="primary"
              onPress={() => window.open(`${process.env.cloudUrl}/settings/billing`, '_blank')}
            >
              {t(labels.upgrade)}
            </Button>
          </EmptyPlaceholder>
        </Panel>
      </Column>
    );
  }

  return (
    <Column gap>
      <WebsiteControls websiteId={websiteId} />
      <Panel
        minHeight="900px"
        allowFullscreen
        minWidth="0"
        width="100%"
        style={{ overflow: 'hidden' }}
      >
        <Column gap="5" minWidth="0" width="100%" paddingTop="2">
          <Column gap="4" minWidth="0" width="100%">
            {isPhone ? (
              <Column gap="3">
                <Row>
                  <SearchField value={search} onSearch={setSearch} placeholder="Search" />
                </Row>
                <Row justifyContent="flex-end">
                  <FilterButtons
                    items={buttons}
                    value={mode}
                    onChange={value => setMode(value as HeatmapMode)}
                  />
                </Row>
              </Column>
            ) : (
              <Row alignItems="center" justifyContent="space-between" gap="4">
                <SearchField value={search} onSearch={setSearch} placeholder="Search" />
                <FilterButtons
                  items={buttons}
                  value={mode}
                  onChange={value => setMode(value as HeatmapMode)}
                />
              </Row>
            )}
          </Column>

          <Heatmap
            websiteId={websiteId}
            selection={selectionByMode[mode]}
            onSelectionChange={selection =>
              setSelectionByMode(state => ({ ...state, [mode]: selection }))
            }
            mode={mode}
            search={search}
          />
        </Column>
      </Panel>
    </Column>
  );
}
