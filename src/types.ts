// User data interfaces
export interface User {
  id: string;
  username: string;
  email: string;
  balance: number;
  avatar?: string;
  createdAt: string;
}

export interface UserBalance {
  total: number;
  available: number;
  pending: number;
}

// Market data interfaces
export interface Market {
  id: string;
  title: string;
  description: string;
  category: string;
  endDate: string;
  status: 'active' | 'resolved' | 'pending';
  yesOdds: number;
  noOdds: number;
  volume: number;
  participants: number;
  outcome?: 'yes' | 'no';
}

export interface MarketCard {
  market: Market;
  userPosition?: {
    side: 'yes' | 'no';
    amount: number;
  };
}

// Navigation interfaces
export interface Category {
  id: string;
  name: string;
  icon?: string;
}

// Modal interfaces
export interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
}

// Component prop interfaces
export interface HeaderProps {
  user: User | null;
  onMenuClick: () => void;
}

export interface BalanceCardProps {
  balance: UserBalance | null;
  currency?: string;
}

export interface MarketCardProps {
  market: Market;
  onBetClick: (marketId: string, side: 'yes' | 'no') => void;
}

export interface SidebarProps {
  categories: Category[];
  selectedCategory: string;
  onCategorySelect: (categoryId: string) => void;
  isOpen: boolean;
}

// API response interfaces
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface MarketsResponse {
  markets: Market[];
  total: number;
  page: number;
}