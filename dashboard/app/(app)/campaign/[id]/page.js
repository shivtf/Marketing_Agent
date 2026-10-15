import CampaignReviewView from '@/components/CampaignReviewView';

export const metadata = { title: 'Campaign review' };

export default async function Page({ params }) {
  const { id } = await params;
  return <CampaignReviewView id={id} />;
}
