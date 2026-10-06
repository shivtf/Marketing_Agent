import { Suspense } from 'react';
import PositiveLeadsView from '@/components/PositiveLeadsView';

export const metadata = { title: 'Positive Leads' };

// Suspense: the view reads the selected group from the URL (useSearchParams).
export default function Page() {
  return (
    <Suspense>
      <PositiveLeadsView />
    </Suspense>
  );
}
