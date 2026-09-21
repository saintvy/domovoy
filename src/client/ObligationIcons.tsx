import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  House,
  Globe,
  Vault,
  Cloud,
  Wifi,
  Phone,
  Zap,
  Droplets,
  Flame,
  Shield,
  Heart,
  Cross,
  GraduationCap,
  School,
  Baby,
  Dog,
  Cat,
  Car,
  Bus,
  TrainFront,
  Plane,
  Bike,
  ShoppingBasket,
  ShoppingBag,
  Utensils,
  Coffee,
  Pizza,
  Shirt,
  Dumbbell,
  Music,
  Film,
  Tv,
  Gamepad2,
  BookOpen,
  Newspaper,
  Laptop,
  Smartphone,
  Printer,
  Camera,
  Palette,
  Wrench,
  Hammer,
  TreePine,
  Flower2,
  Gift,
  CreditCard,
  Wallet,
  Landmark,
  Building2,
  KeyRound,
  Search,
  X,
  Check,
  type LucideIcon,
} from 'lucide-react';
import { brandIcons } from './obligation-brand-icons';
import './obligation-icons.css';

export type IconCategory = 'generic' | 'music' | 'video' | 'services';
export interface ObligationIconEntry {
  id: string;
  name: string;
  nameRu: string;
  category: IconCategory;
  keywords: string;
  component?: LucideIcon;
  path?: string;
  color?: string;
}
const generic = (
  id: string,
  nameRu: string,
  name: string,
  component: LucideIcon,
  keywords = '',
): ObligationIconEntry => ({
  id: 'generic:' + id,
  nameRu,
  name,
  category: 'generic',
  component,
  keywords,
});

const genericIcons: ObligationIconEntry[] = [
  generic(
    'house',
    'Дом',
    'Home',
    House,
    'аренда жилье квартира rent apartment',
  ),
  generic('globe', 'Планета', 'Globe', Globe, 'мир интернет world internet'),
  generic(
    'vault',
    'Сейф',
    'Safe',
    Vault,
    'хранение накопления сбережения savings',
  ),
  generic('cloud', 'Облако', 'Cloud', Cloud, 'хранилище storage backup'),
  generic('wifi', 'Интернет', 'Internet', Wifi, 'вайфай связь broadband'),
  generic('phone', 'Телефон', 'Phone', Phone, 'звонки связь calls'),
  generic(
    'electricity',
    'Электричество',
    'Electricity',
    Zap,
    'свет энергия коммунальные power',
  ),
  generic(
    'water',
    'Вода',
    'Water',
    Droplets,
    'водоснабжение коммунальные utility',
  ),
  generic(
    'heating',
    'Отопление',
    'Heating',
    Flame,
    'газ тепло коммунальные gas',
  ),
  generic('insurance', 'Страховка', 'Insurance', Shield, 'защита protection'),
  generic('health', 'Здоровье', 'Health', Heart, 'медицина врач doctor'),
  generic('medicine', 'Лекарства', 'Medicine', Cross, 'аптека pharmacy'),
  generic(
    'education',
    'Образование',
    'Education',
    GraduationCap,
    'курсы учеба tuition course',
  ),
  generic('school', 'Школа', 'School', School, 'детский сад kindergarten'),
  generic('baby', 'Ребёнок', 'Baby', Baby, 'дети няня childcare'),
  generic('dog', 'Собака', 'Dog', Dog, 'питомец корм pet food'),
  generic('cat', 'Кошка', 'Cat', Cat, 'питомец ветеринар pet vet'),
  generic(
    'car',
    'Автомобиль',
    'Car',
    Car,
    'машина бензин парковка fuel parking',
  ),
  generic('bus', 'Автобус', 'Bus', Bus, 'проезд транспорт transit'),
  generic('train', 'Поезд', 'Train', TrainFront, 'метро транспорт railway'),
  generic(
    'plane',
    'Самолёт',
    'Plane',
    Plane,
    'путешествия билеты travel flights',
  ),
  generic(
    'bike',
    'Велосипед',
    'Bicycle',
    Bike,
    'велосипед прокат cycling rental',
  ),
  generic(
    'groceries',
    'Продукты',
    'Groceries',
    ShoppingBasket,
    'еда супермаркет food supermarket',
  ),
  generic(
    'shopping',
    'Покупки',
    'Shopping',
    ShoppingBag,
    'магазин товары store',
  ),
  generic(
    'restaurant',
    'Ресторан',
    'Restaurant',
    Utensils,
    'обеды еда lunch dining',
  ),
  generic('coffee', 'Кофе', 'Coffee', Coffee, 'кафе напитки cafe drinks'),
  generic('delivery', 'Доставка еды', 'Food delivery', Pizza, 'пицца takeout'),
  generic('clothes', 'Одежда', 'Clothing', Shirt, 'вещи обувь shoes'),
  generic(
    'fitness',
    'Спортзал',
    'Fitness',
    Dumbbell,
    'спорт тренировка gym exercise',
  ),
  generic('music', 'Музыка', 'Music', Music, 'подписка аудио audio streaming'),
  generic('film', 'Кино', 'Films', Film, 'фильмы сериалы movies cinema'),
  generic('tv', 'Телевидение', 'Television', Tv, 'тв каналы tv channels'),
  generic('games', 'Игры', 'Games', Gamepad2, 'игровая подписка gaming'),
  generic('books', 'Книги', 'Books', BookOpen, 'чтение библиотека reading'),
  generic('news', 'Пресса', 'News', Newspaper, 'газеты журналы magazines'),
  generic(
    'computer',
    'Компьютер',
    'Computer',
    Laptop,
    'ноутбук программа software',
  ),
  generic(
    'mobile',
    'Мобильная связь',
    'Mobile plan',
    Smartphone,
    'смартфон тариф cellular',
  ),
  generic(
    'printing',
    'Печать',
    'Printing',
    Printer,
    'принтер документы documents',
  ),
  generic('camera', 'Фотография', 'Photography', Camera, 'фото photography'),
  generic('art', 'Творчество', 'Art', Palette, 'рисование дизайн design'),
  generic(
    'repairs',
    'Ремонт',
    'Repairs',
    Wrench,
    'мастер обслуживание maintenance',
  ),
  generic(
    'tools',
    'Инструменты',
    'Tools',
    Hammer,
    'строительство construction',
  ),
  generic('garden', 'Сад', 'Garden', TreePine, 'участок природа outdoors'),
  generic('flowers', 'Цветы', 'Flowers', Flower2, 'растения plants'),
  generic('gifts', 'Подарки', 'Gifts', Gift, 'праздники праздник celebration'),
  generic(
    'card',
    'Банковская карта',
    'Bank card',
    CreditCard,
    'комиссия банк fee',
  ),
  generic('wallet', 'Кошелёк', 'Wallet', Wallet, 'деньги финансы money'),
  generic('bank', 'Банк', 'Bank', Landmark, 'кредит ипотека loan mortgage'),
  generic(
    'building',
    'Здание',
    'Building',
    Building2,
    'офис квартира office property',
  ),
  generic('key', 'Ключ', 'Key', KeyRound, 'аренда доступ rent access'),
];

export const obligationIconCatalog: readonly ObligationIconEntry[] = [
  ...genericIcons,
  ...brandIcons.map((icon) => ({ ...icon, nameRu: icon.name })),
];
const byId = new Map(obligationIconCatalog.map((icon) => [icon.id, icon]));
const normalize = (value: string) =>
  value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').trim();
export function findObligationIcons(
  query = '',
  category: IconCategory | 'all' = 'all',
) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  return obligationIconCatalog.filter((icon) => {
    if (category !== 'all' && icon.category !== category) return false;
    const text = normalize(icon.name + ' ' + icon.nameRu + ' ' + icon.keywords);
    return words.every((word) => text.includes(word));
  });
}

/** Unknown IDs render a neutral fallback. Paths are trusted local constants, never user SVG. */
export function ObligationIcon({
  iconId,
  size = 24,
  className = '',
  label,
  color,
}: {
  iconId?: string;
  size?: number;
  className?: string;
  label?: string;
  color?: string;
}) {
  const icon = byId.get(iconId || '') || genericIcons[0];
  const accessible = label
    ? { role: 'img' as const, 'aria-label': label }
    : { 'aria-hidden': true as const };
  if (icon.component) {
    const Component = icon.component;
    return (
      <Component
        size={size}
        strokeWidth={1.8}
        style={color ? { color } : undefined}
        className={'obligation-icon ' + className}
        {...accessible}
      />
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={'obligation-icon ' + className}
      focusable="false"
      style={color ? { color } : undefined}
      {...accessible}
    >
      <path d={icon.path} fill="currentColor" />
    </svg>
  );
}

const tabs: { id: IconCategory | 'all'; ru: string; en: string }[] = [
  { id: 'all', ru: 'Все', en: 'All' },
  { id: 'generic', ru: 'Общие', en: 'General' },
  { id: 'music', ru: 'Музыка', en: 'Music' },
  { id: 'video', ru: 'Кино и ТВ', en: 'Film & TV' },
  { id: 'services', ru: 'Сервисы', en: 'Services' },
];
const defaultText = (ru: string, _en: string) => ru;

export function IconPicker({
  value,
  onSelect,
  onClose,
  t = defaultText,
}: {
  value?: string;
  onSelect: (iconId: string) => void;
  onClose: () => void;
  t?: (ru: string, en: string) => string;
}) {
  const [category, setCategory] = useState<IconCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const results = findObligationIcons(query, category);
  const selected = byId.get(value || '');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    search.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [
      ...(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]),input',
      ) || []),
    ];
    const first = focusable[0],
      last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft')
      next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    setCategory(tabs[next].id);
    document.getElementById(id + '-tab-' + tabs[next].id)?.focus();
  }
  return createPortal(
    <div
      className="obligation-icon-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="obligation-icon-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id + '-title'}
        ref={dialog}
        onKeyDown={keyboard}
      >
        <div className="obligation-icon-heading">
          <div>
            <h2 id={id + '-title'}>
              {t('Значок обязательства', 'Obligation icon')}
            </h2>
            <p>
              {t(
                'Найдите услугу или выберите подходящий символ.',
                'Find a service or choose a symbol.',
              )}
            </p>
          </div>
          <button
            type="button"
            className="obligation-icon-close"
            aria-label={t('Закрыть выбор значка', 'Close icon picker')}
            onClick={onClose}
          >
            <X size={22} aria-hidden="true" />
          </button>
        </div>
        <label className="obligation-icon-search" htmlFor={id + '-search'}>
          <Search size={19} aria-hidden="true" />
          <span className="obligation-icon-sr">
            {t('Поиск значков', 'Search icons')}
          </span>
          <input
            id={id + '-search'}
            ref={search}
            type="search"
            value={query}
            autoComplete="off"
            placeholder={t(
              'Например: аренда, музыка, Netflix…',
              'Try: rent, music, Netflix…',
            )}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          role="tablist"
          aria-label={t('Категории значков', 'Icon categories')}
          className="obligation-icon-tabs"
        >
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              id={id + '-tab-' + tab.id}
              type="button"
              role="tab"
              aria-selected={category === tab.id}
              aria-controls={id + '-results'}
              tabIndex={category === tab.id ? 0 : -1}
              onKeyDown={(event) => tabKey(event, index)}
              onClick={() => setCategory(tab.id)}
            >
              {t(tab.ru, tab.en)}
            </button>
          ))}
        </div>
        <p className="obligation-icon-count" role="status" aria-live="polite">
          {t('Найдено значков:', 'Icons found:')} {results.length}
        </p>
        <div
          id={id + '-results'}
          role="tabpanel"
          aria-labelledby={id + '-tab-' + category}
          className="obligation-icon-results"
        >
          {results.length ? (
            <div className="obligation-icon-grid">
              {results.map((icon) => (
                <button
                  type="button"
                  key={icon.id}
                  className={
                    'obligation-icon-choice' +
                    (value === icon.id ? ' is-selected' : '')
                  }
                  aria-pressed={value === icon.id}
                  title={t(icon.nameRu, icon.name)}
                  onClick={() => {
                    onSelect(icon.id);
                    onClose();
                  }}
                >
                  <span className="obligation-icon-preview">
                    <ObligationIcon iconId={icon.id} size={27} />
                    {value === icon.id && (
                      <Check
                        className="obligation-icon-check"
                        size={13}
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <span>{t(icon.nameRu, icon.name)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="obligation-icon-empty">
              <Search size={28} aria-hidden="true" />
              <p>
                {t(
                  'Ничего не найдено. Попробуйте другое название или вкладку «Все».',
                  'No matches. Try another name or the All tab.',
                )}
              </p>
            </div>
          )}
        </div>
        <div className="obligation-icon-footer">
          <span>
            {selected
              ? t('Выбран: ', 'Selected: ') + t(selected.nameRu, selected.name)
              : t('Выберите один значок', 'Choose one icon')}
          </span>
          <button type="button" onClick={onClose}>
            {t('Отмена', 'Cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
