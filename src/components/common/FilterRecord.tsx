import {
  Button,
  Column,
  ComboBox,
  Grid,
  Icon,
  Label,
  ListItem,
  Loading,
  Select,
  TextField,
} from '@umami/react-zen';
import { useState } from 'react';
import { Empty } from '@/components/common/Empty';
import { MultiSelect } from '@/components/common/MultiSelect';
import { useApi, useFilters, useFormat, useMessages, useWebsiteValuesQuery } from '@/components/hooks';
import { X } from '@/components/icons';
import { isSearchOperator } from '@/lib/params';
import { endOfDay, subMonths } from 'date-fns';

export interface FilterRecordProps {
  websiteId?: string;
  type: string;
  startDate: Date;
  endDate: Date;
  name: string;
  operator: string;
  value: string | string[];
  onSelect?: (name: string, value: any) => void;
  onRemove?: (name: string) => void;
  onChange?: (name: string, value: string) => void;
}

function EventPropertyFilter({
  websiteId,
  name,
  operator,
  value,
  onSelect,
  onRemove,
  onChange,
}: FilterRecordProps) {
  const { t, labels } = useMessages();
  const { get, useQuery } = useApi();
  const startAt = +subMonths(endOfDay(new Date()), 6);
  const endAt = +endOfDay(new Date());

  const pipeIdx = (value as string).indexOf('|');
  const [propertyName, setPropertyName] = useState(
    pipeIdx >= 0 ? (value as string).slice(0, pipeIdx) : (value as string),
  );
  const [propertyValue, setPropertyValue] = useState(
    pipeIdx >= 0 ? (value as string).slice(pipeIdx + 1) : '',
  );

  const { data, isLoading } = useQuery<Array<{ propertyName: string }>>({
    queryKey: ['event-data:properties', { websiteId, searchValue: '', startAt, endAt }],
    queryFn: () => get(`/websites/${websiteId}/event-data/properties`, { startAt, endAt }),
    enabled: !!websiteId,
  });

  const properties = [...new Set(data?.map(d => d.propertyName) ?? [])];

  const handlePropertyChange = (v: string) => {
    setPropertyName(v);
    onChange?.(name, `${v}|${propertyValue}`);
  };

  const handleValueChange = (v: string) => {
    setPropertyValue(v);
    onChange?.(name, `${propertyName}|${v}`);
  };

  return (
    <Column>
      <Label>{t(labels.eventProperty)}</Label>
      <Grid columns="1fr auto 1fr auto auto" gap alignItems="start">
        <ComboBox
          aria-label="property"
          items={properties}
          inputValue={propertyName}
          onInputChange={handlePropertyChange}
          formValue="text"
          allowsEmptyCollection
          allowsCustomValue
          renderEmptyState={() =>
            isLoading ? <Loading icon="dots" /> : <Empty />
          }
        >
          {properties.map(p => (
            <ListItem key={p} id={p}>
              {p}
            </ListItem>
          ))}
        </ComboBox>
        <Select value={operator} onChange={v => onSelect?.(name, v)}>
          <ListItem id="eq">{t(labels.is)}</ListItem>
          <ListItem id="neq">{t(labels.isNot)}</ListItem>
          <ListItem id="c">{t(labels.contains)}</ListItem>
          <ListItem id="dnc">{t(labels.doesNotContain)}</ListItem>
        </Select>
        <TextField value={propertyValue} onChange={handleValueChange} />
        <Button onPress={() => onRemove?.(name)}>
          <Icon>
            <X />
          </Icon>
        </Button>
      </Grid>
    </Column>
  );
}

export function FilterRecord(props: FilterRecordProps) {
  const { type } = props;
  if (type === 'eventProperty' || type.replace(/\d+$/, '') === 'eventProperty') {
    return <EventPropertyFilter {...props} />;
  }
  return <StandardFilterRecord {...props} />;
}

function StandardFilterRecord({
  websiteId,
  type,
  startDate,
  endDate,
  name,
  operator,
  value,
  onSelect,
  onRemove,
  onChange,
}: FilterRecordProps) {
  const { fields, operators } = useFilters();
  const initValues = Array.isArray(value) ? value : value ? value.split(',') : [];
  const [selected, setSelected] = useState<string[]>(initValues);
  const [search, setSearch] = useState('');
  const { formatValue } = useFormat();
  const { data, isLoading } = useWebsiteValuesQuery({
    websiteId,
    type,
    search,
    startDate,
    endDate,
  });
  const isSearch = isSearchOperator(operator);
  const items = data?.filter(({ value }) => value) || [];

  const handleSearch = (value: string) => {
    setSearch(value);
  };

  const handleSelectOperator = (value: any) => {
    onSelect?.(name, value);
  };

  const handleSelectValue = (value: string) => {
    setSelected([value]);
    onChange?.(name, value);
  };

  const handleMultiSelectValue = (values: string[]) => {
    setSelected(values);
    onChange?.(name, values.join(','));
  };

  return (
    <Column>
      <Label>{fields.find(f => f.name === name)?.label}</Label>
      <Grid columns="1fr auto" gap>
        <Grid columns={{ base: '1fr', md: '200px 1fr' }} gap>
          <Select value={operator} onChange={handleSelectOperator}>
            {operators
              .filter(({ type }) => type === 'string')
              .map(({ name, label }: any) => (
                <ListItem key={name} id={name}>
                  {label}
                </ListItem>
              ))}
          </Select>
          {isSearch && (
            <TextField
              value={selected[0] || ''}
              defaultValue={selected[0] || ''}
              onChange={handleSelectValue}
            />
          )}
          {!isSearch && (
            <MultiSelect
              value={selected}
              onChange={handleMultiSelectValue}
              searchValue={search}
              onSearch={handleSearch}
              renderValue={values =>
                values.length > 0 ? values.map(v => formatValue(v, type)).join(', ') : undefined
              }
              renderEmptyState={() => (isLoading ? <Loading icon="dots" /> : <Empty />)}
              allowSearch
            >
              {items.map(({ value }) => (
                <ListItem key={value} id={value}>
                  {formatValue(value, type)}
                </ListItem>
              ))}
            </MultiSelect>
          )}
        </Grid>
        <Column justifyContent="flex-start">
          <Button onPress={() => onRemove?.(name)}>
            <Icon>
              <X />
            </Icon>
          </Button>
        </Column>
      </Grid>
    </Column>
  );
}
