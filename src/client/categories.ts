export const obligationCategories: Record<string, readonly [string, string]> = {
  subscriptions: ['Подписки', 'Subscriptions'],
  home: ['Дом', 'Home'],
  housing: ['Дом и аренда', 'Home & rent'],
  utilities: ['Коммунальные услуги', 'Utilities'],
  entertainment: ['Развлечения', 'Entertainment'],
  education: ['Образование', 'Education'],
  digital: ['Сервисы', 'Services'],
  insurance: ['Страхование', 'Insurance'],
  transport: ['Транспорт', 'Transport'],
  other: ['Другое', 'Other'],
};
export function categoryLabel(
  category: string | undefined,
  t: (ru: string, en: string) => string,
): string {
  const labels = obligationCategories[category ?? ''];
  return labels ? t(...labels) : category || t('Подписка', 'Subscription');
}
