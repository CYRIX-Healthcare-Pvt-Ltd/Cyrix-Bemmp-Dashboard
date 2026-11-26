-- =====================================================================
-- BEMMP · 0090 · Care 360 and Private BEMMP exports can be shared
--
-- 62756ae (25 Nov) added the c360 and pvt contracts, but dataset and meeting_note still allowed only kl, ap
-- and up. Sabin Sunny (E1388) loaded Care 360 on 25 Nov 12:47: the file reached storage, the dataset row was
-- refused, so the export stayed on Sabin's device and everyone else saw "Load a BEMMP ticket export"
-- (the user, 26 Nov). Widens both checks and records Sabin's upload, read from its own meta.json.gz.
-- =====================================================================

alter table dataset drop constraint if exists dataset_state_check;
alter table dataset add constraint dataset_state_check check (state in ('kl', 'ap', 'up', 'c360', 'pvt'));

alter table meeting_note drop constraint if exists meeting_note_state_check;
alter table meeting_note add constraint meeting_note_state_check check (state in ('kl', 'ap', 'up', 'c360', 'pvt'));

insert into dataset (state, rows, min_day, max_day, filename, bytes, encoding, uploaded_by, uploaded_at, version,
                     zones, districts, uploaded_by_code, uploaded_by_name)
select 'c360', 7342, 45582, 46351, 'Care 360.xlsx', 125683 + 161421, 'gzip', p.id,
       timestamptz '2026-11-25 07:17:12+00', '2026-11-25T07-17-10-381Z',
       array['Punjab', 'Assam', 'Kerala', 'Andhra Pradesh', 'Jharkhand', 'Tamil Nadu', 'Chhattisgarh', 'Sikkim', 'Uttar Pradesh', 'West Bengal', 'Madhya Pradesh', 'Delhi', 'Telangana', 'Jammu Kashmir', 'Haryana', 'Karnataka', 'Odisha']::text[],
       array['Faridkot', 'Bathinda', 'Sivasagar', 'Thrissur', 'Malappuram', 'Ernakulam', 'Palakkad', 'West Godavari', 'Kakinada', 'Dhanbad', 'Bokaro', 'Salem', 'Coimbatore', 'Kannur', 'Kottayam', 'Pathanamthitta', 'Thiruvananthapuram', 'Kozhikode', 'Kanyakumari', 'Visakhapatnam', 'Jashpur', 'Dhamtari', 'Raipur', 'Korba', 'Surajpur', 'Bilaspur', 'Manendragarh-Chirmiri-Bharatpur (MCB) - Chhattigarh', 'Raigarh', 'Janjgir Champa', 'Durg', 'Kondagaon', 'kawardha', 'Bemetara', 'Rajnandgaon', 'Sakti', 'khairagarh', 'Baloda Bazar', 'Koriya', 'Kanker', 'Mahasamund', 'Balod', 'Sarangarh-Bilaigarh', 'Balrampur', 'Surguja', 'Bijapur', 'Sukma', 'Mungeli', 'Bastar', 'Gariaband', 'Narayanpur', 'Gangtok', 'Prayagraj', 'Gaurela Pendra Marwahi', 'Mohla-Manpur-Ambagarh Chowki', 'Chennai', 'Bardhaman', 'Ranchi', 'Bhopal', 'New Delhi', 'Lucknow', 'Hyderabad', 'Srinagar', 'Dantewada', 'Ghaziabad', 'Kasaragod', 'Gurugram', 'Dharwad', 'Khordha', 'Erode', 'Idukki', 'Srikakulam', 'Theni', 'Wayanad', 'East Delhi', 'West Delhi', 'Kolkata', 'Kendujhar']::text[],
       p.code, p.full_name
from profile p where p.code = 'E1388'
on conflict (state) do nothing;
