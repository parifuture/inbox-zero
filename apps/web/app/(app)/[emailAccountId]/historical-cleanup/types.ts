import type {
  HistoricalSenderItem,
  HistoricalSendersQuery,
} from "@/app/api/historical-senders/route";

export type SenderStatusFilter = HistoricalSendersQuery["status"];
export type SenderSortKey = HistoricalSendersQuery["sort"];
export type SenderSortOrder = HistoricalSendersQuery["order"];

export type Sender = HistoricalSenderItem;

export type HistoricalSendersListParams = {
  search: string;
  status: SenderStatusFilter;
  sort: SenderSortKey;
  order: SenderSortOrder;
  minCount: number;
  limit: number;
  offset: number;
};
