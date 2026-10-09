// Campaigns (app/api/campaigns). Everyone signed in can see them; only admins can add, change or delete.
import { authFetch } from './auth';

const PATH = '/api/campaigns';

// -> [{ id, campaignName, campaignDetail, startDate, endDate, isActive, createdAt, updatedAt }]
export const listCampaigns = () => authFetch(PATH);

// { campaignName, campaignDetail, startDate: 'YYYY-MM-DD', endDate, isActive } -> the new campaign
export const createCampaign = (c) => authFetch(PATH, { method: 'POST', body: JSON.stringify(c) });

// Any of the fields above -> the updated campaign
export const updateCampaign = (id, changes) => authFetch(`${PATH}/${id}`, { method: 'PATCH', body: JSON.stringify(changes) });

export const deleteCampaign = (id) => authFetch(`${PATH}/${id}`, { method: 'DELETE' });
