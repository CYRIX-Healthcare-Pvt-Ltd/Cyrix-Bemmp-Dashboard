/**
 * The eleven PM checklists, row for row as the PDFs the user sent on 31 Oct
 * 2026 (CHPL/SER/GB-PMS-…). Changing a row's wording changes its id, so a
 * row reworded later starts a new Excel column rather than relabelling old
 * answers.
 *
 * A row is a check by default: one press of OK / Not OK / N/A, a remark if
 * needed. `fields` are the readings the form leaves blanks for, `expect` the
 * expected value printed beside it, `options` the form's own choices where it
 * prints them (the ultrasound sheet), `measure` a row whose remark column is
 * the measured value. `text` rows are written answers; `params` is the
 * general sheet's empty parameter table.
 */

const OK = ['OK', 'Not OK', 'N/A'];
const YES_NO = ['Yes', 'No'];
const N = ['Normal', 'Abnormal'];
const NI = ['Normal', 'Abnormal', 'Not involved'];
const CL = ['Cleaned', 'Unfinished'];

/** The answers counted as a problem in the summary. */
export const BAD = new Set(['Not OK', 'Abnormal', 'Unfinished']);

const one = (unit, label) => [{ k: 'v', unit, label }];
const V3 = [{ k: 'ln', label: 'L-N', unit: 'V' }, { k: 'lg', label: 'L-G', unit: 'V' }, { k: 'ng', label: 'N-G', unit: 'V' }];
const SM = (unit) => [{ k: 'set', label: 'Set', unit }, { k: 'meas', label: 'Measured', unit }];
const M = (unit) => [{ k: 'meas', label: 'Measured', unit }];
const BATTERY = [{ k: 'v', unit: 'V' }, { k: 'bt', label: 'Back up time', unit: 'min' }];
const RPM = [{ k: 'rpm', label: 'RPM' }, { k: 'flow', label: 'Flowrate' }];
const ex = (label, expect) => ({ label, expect, measure: true });

const RAW = [
  {
    code: 'ANU', name: 'Anesthesia Unit', form: 'CHPL/SER/GB-PMS-ANU',
    sections: [
      { title: 'Physical Inspection', items: [
        { label: 'Check the Power code and cables' },
        { label: 'Inspect the ventilator body and wheels' },
        { label: 'Clean Exterior' },
        { label: 'Clean and replace the air inlet filter' },
        { label: 'Verify user interface (Touch screen, Physical switches/Nobes etc.)' },
        { label: 'Oxygen Inlet Pressure', fields: one('Bar/PSI') },
        { label: 'Air Inlet Pressure (IF Applicable)', fields: one('Bar/PSI') },
        { label: 'Ventilator usage Duration', fields: one('Hr') },
        { label: 'Perform Self-Test' },
        { label: 'Alarm Verification' },
        { label: 'Line Voltage', fields: V3 },
        { label: 'Battery Health /Backup', fields: BATTERY },
        { label: 'Verify user interface (Touch screen, Physical switches/Nobes etc)' },
        { label: 'Perform leak Test' },
        { label: 'Perform Self-Test' },
        { label: 'Alarm Verification' },
        { label: 'Verify back up Cylinder' },
        { label: 'Check O2 Flush Valve' },
        { label: 'Check APL Valve', fields: SM('cm/H2O') },
        { label: 'Bag/Ventilator Switch' },
      ] },
      { title: 'Performance Test value', items: [
        { label: 'Tidal Volume Accuracy', fields: SM('L') },
        { label: 'PEEP', fields: SM('cm/H2O') },
        { label: 'PIP', fields: SM('cm/H2O') },
        { label: 'RR', fields: SM('BPM') },
        { label: 'FiO2', fields: M('LPM') },
        { label: 'N2O', fields: SM('LPM') },
      ] },
    ],
  },
  {
    code: 'CRS', name: 'CR System', form: 'CHPL/SER/GB-PMS-CRS',
    sections: [
      { title: 'Power Condition', items: [
        { label: 'Phase to Neutral (VAC)', fields: one('V') },
        { label: 'Phase to Earth (VAC)', fields: one('V') },
        { label: 'Neutral to Earth (VAC)', fields: one('V') },
        { label: 'UPS/Backup Time' },
        { label: 'Proper Protective Grounding' },
        { label: 'Backing & Checking error logs' },
        { label: 'Major Errors' },
        { label: 'Check for any Abnormal Sound' },
        { label: 'Part Changed since last PM', options: YES_NO },
        { label: 'Check for Image Conveyance (White line 2 mm)' },
        { label: 'Checking the Erasure Lamp Lighting Time' },
        { label: 'Turning OFF the High-Voltage Switch' },
      ] },
      { title: 'Removing and Cleaning Covers & Louvers', items: [
        { label: 'Front & Rear Cover, Right-Left side cover, Cleaning Air Filter, Louvers' },
        { label: 'Front cover, Front cover plate. Right & Left side cover.' },
        { label: 'Rear cover, Rear cover Plate, Dust-tight cover assembly' },
        { label: 'Operation panel assembly' },
      ] },
      { title: 'Erasure Unit', items: [
        { label: 'Cleaning Erasure Lamp Filter' },
        { label: 'Cleaning Reflection Plate' },
        { label: 'Cleaning of Brush rollers' },
      ] },
      { title: 'Cassette Set Unit', items: [
        { label: 'Cleaning the Suction Cups (Left-Hand) & Hose' },
        { label: 'Cleaning the Suction Cups (Right-Hand) & Hose' },
        { label: 'Cleaning the Rubber Rollers' },
        { label: 'Cleaning the Antistatic Member and Shutter' },
        { label: 'Cleaning inside Machine' },
      ] },
      { title: 'Side-Positioning Conveyor Unit', items: [
        { label: 'Cleaning the Guide, Rubber Rollers, Shock-Absorbing Rollers, Antistatic Members, and Guide' },
      ] },
      { title: 'Sub scanning Unit', items: [
        { label: 'Cleaning Guides, Center Rollers, Rubber Rollers' },
        { label: 'Cleaning the Flywheel (Large & Small), Kapton® Belt' },
        { label: 'Cleaning inside Machine' },
      ] },
      { title: 'Light-Collecting Guide', items: [
        { label: 'Cleaning Light-Collecting Guide' },
        { label: 'Cleaning the Post-Reading Conveyor Guide Assembly' },
        { label: 'Checking the Image/Conveyance' },
        { label: 'Confirming the S Value' },
        { label: 'Checking the Error Log' },
      ] },
    ],
  },
  {
    code: 'DLM', name: 'Dialysis Machine', form: 'CHPL/SER/GB-PMS-DLM',
    sections: [
      { title: null, items: [
        { label: 'Chassis / Housing/ Castors & Brakes' },
        { label: 'AC Plug / Receptacle/ Line Cord' },
        { label: 'Circuit Breaker / Fuse' },
        { label: 'Fittings / Connectors' },
        { label: 'Controls / Switches' },
        { label: 'Line Voltage', fields: V3 },
        { label: 'Battery (Health- Voltage)', fields: one('V') },
        { label: 'Indicators / Displays' },
        { label: 'Alarms / Interlocks' },
        { label: 'Audible Signals' },
        { label: 'Labelling' },
        { label: 'Accessories' },
      ] },
      { title: null, items: [
        { label: 'Clean the exterior /Interior/ accessories' },
        { label: 'Check the Filter (If required please replace)' },
        { label: 'Perform the pre-use check' },
        { label: 'Internal Tubing Check (Discoloration, Crack, Blocks Etc.)' },
        { label: 'Check Internal Water Leakage' },
        { label: 'Check inlet water flow and adjust if necessary' },
        { label: 'Check concentrate for expiry and other details' },
        { label: 'Check the error logs' },
        { label: 'Perform the internal calibrations' },
        { label: 'Conductivity Check', fields: one('mS/cm') },
        { label: 'Water TDS' },
        { label: 'Degassing Pump', fields: RPM },
        { label: 'Flow pump', fields: RPM },
        { label: 'Inspect concentrate aspirator for clogging and clear if any' },
        { label: 'Inspect blood pump (Lock and fittings)' },
        { label: 'Perform dummy dialysis' },
        { label: 'Inspect all pumps and replace necessary components' },
        { label: 'Inspect drain connection' },
        { label: 'Inspect dialyzer ports' },
        { label: 'Inspect heparin pump' },
      ] },
    ],
  },
  {
    code: 'FLP', name: 'Film Printer', form: 'CHPL/SER/GB-PMS-FLP',
    sections: [
      { title: 'Power Conditions', items: [
        { label: 'Phase to Neutral (VAC)', fields: one('V') },
        { label: 'Phase to Earth (VAC)', fields: one('V') },
        { label: 'Neutral to Earth (VAC)', fields: one('V') },
        { label: 'UPS/Backup Time' },
        { label: 'Proper Protective Grounding' },
        { label: 'Backing & Checking error logs' },
        { label: 'Major Errors' },
        { label: 'Check for any Abnormal Sound' },
        { label: 'Part Changed since last PM', options: YES_NO },
        { label: 'Check for Image Conveyance (Image Shift/Width/Artifact/Scratches)' },
        { label: 'Checking the Interlock Function' },
        { label: 'Checking the Fan Operations' },
      ] },
      { title: 'Tray & Magazine', items: [
        { label: 'Checking the Tray (Visual & Mechanical Operation)' },
        { label: 'Checking Magazine Detection (Visual & Mechanical Operation)' },
        { label: 'Cleaning of "Cleaning Roller"' },
        { label: 'Cleaning of Air Filters' },
      ] },
      { title: 'Removal Unit', items: [
        { label: 'Cleaning the Removal Unit, Cleaning Inside the Equipment' },
        { label: 'Checking & Cleaning of Rubber Belt' },
        { label: 'Cleaning the Sub-scanning Conveyance Roller' },
        { label: 'Cleaning the Density Measurement Section' },
        { label: 'Cleaning Film Release Section' },
      ] },
      { title: 'Heat Development Unit', items: [
        { label: 'Cleaning the Heat Development Unit' },
        { label: 'Cleaning Thermal Head (If Applicable)' },
        { label: 'Greasing (only If Applicable)' },
        { label: 'Cleaning the Platen Roller and Conveyor Exit Roller' },
        { label: 'Cleaning & Fixing of Covers' },
        { label: 'Setting Date and Time' },
        { label: 'Final Operation Checks/Checking Images' },
        { label: 'Checking the Error Log' },
      ] },
    ],
  },
  {
    code: 'GNE', name: 'General Equipment', form: 'CHPL/SER/GB-PMS-GNE',
    sections: [
      { title: 'Qualitative Tasks', items: [
        { label: 'Chassis / Housing / Castors & Brakes' },
        { label: 'AC Plug / Receptacle / Line Cord / Breakers' },
        { label: 'Fittings / Connectors / Cables' },
        { label: 'Controls / Switches / Labeling' },
        { label: 'Line Voltage (L-N, L-G, N-G)', fields: V3 },
        { label: 'Ground Continuity / Battery Health', fields: [{ k: 'g', label: 'Ground', unit: 'Ω' }, { k: 'b', label: 'Battery', unit: 'V' }] },
        { label: 'Indicators / Displays / Alarms / Audible Signals' },
      ] },
      { title: 'Preventive Maintenance Tasks', items: [
        { label: 'Clean exterior, interior, cooling fans & vents' },
        { label: 'Perform pre-use check / Power on Self-Test' },
        { label: 'Check cables, tubes, and patient lead for wear' },
        { label: 'Verify internal battery / Unplug test' },
        { label: 'Verify touchscreen & Check error logs' },
      ] },
      { title: 'Parameter / Checkpoints', items: [
        { label: 'Parameters', params: 4 },
      ] },
    ],
  },
  {
    code: 'HMA', name: 'Hematology Analyser', form: 'CHPL/SER/GB-PMS-HMA',
    sections: [
      { title: 'Power & Environmental Conditions', items: [
        { label: 'Phase to Neutral / Phase to Earth / Neutral to Earth (VAC)', fields: [{ k: 'pn', label: 'P-N', unit: 'V' }, { k: 'pe', label: 'P-E', unit: 'V' }, { k: 'ne', label: 'N-E', unit: 'V' }] },
        { label: 'Verify Backup Time / UPS Status' },
      ] },
      { title: 'System & Data Management', items: [
        { label: 'Backing up & Checking error logs (including Major Errors)' },
        { label: 'Verify Interlock function and Fan operations' },
      ] },
      { title: 'Aspiration & Sampling Module', items: [
        { label: 'Inspect and clean the sample aspiration needle/probe (with alcohol wipes)' },
        { label: 'Verify probe alignment, movement, and wash block' },
        { label: 'Clean and lubricate guide rails, gears, and syringe pistons' },
      ] },
      { title: 'Fluidic & Pneumatic System', items: [
        { label: 'Inspect and clean tubing for diluent, lyse, and waste' },
        { label: 'Empty waste container and clean waste sensor' },
        { label: 'Disassemble and clean valves with visible crystallization' },
        { label: 'Perform fluidic system flushing and washing functions' },
      ] },
      { title: 'Measurement & Counting Chambers', items: [
        { label: 'Open and clean RBC and WBC Chambers (remove blood stains)' },
        { label: 'Perform Aperture Zapping / Backflush to remove microscopic blockages' },
        { label: 'Clean the HGB flow cell / optical assembly' },
      ] },
      { title: 'Reagent System', items: [
        { label: 'Verify reagent levels (diluent, lyse) and replace if expired' },
        { label: 'Prime all reagent lines and check for air bubbles' },
      ] },
      { title: 'Component & Internal Checks', items: [
        { label: 'Inspect electronic connectors & cables (RBC/WBC sensor connection)' },
        { label: 'Check compressor, vacuum pressure levels, and pump performance' },
      ] },
      { title: 'Final Operation Checks & Calibration', items: [
        { label: 'Run Blank / Background testing (verify limits for sample carryover)' },
        { label: 'Run Quality Control (QC) analysis (L, N, H levels)' },
        { label: 'Calibration / QC values are within target range (Please Mention the readings)', measure: true },
        { label: 'Part Changed since last PM', options: YES_NO },
      ] },
    ],
  },
  {
    code: 'SAA', name: 'Semi Auto Analyser', form: 'CHPL/SER/GB-PMS-SAA',
    sections: [
      { part: 'Part A: General & Electrical', title: 'Power Supply & Multimeter Checks', items: [
        ex('Mains Voltage L–N (Multimeter)', '220–240 V ±5%'),
        ex('Earth / Ground Resistance (Multimeter)', '≤ 0.1 Ω'),
        ex('DC Test Points (e.g., +5V, ±12V) if access.', 'Within ±5% of rating'),
        ex('UPS Status & Battery Backup', 'Verified / Functional'),
      ] },
      { title: 'Physical & Environmental', items: [
        ex('Operating Environment', 'Airflow clear / Temp OK'),
        ex('Keypad / Touchscreen', 'Responsive / Clean'),
        ex('Built-in Thermal Printer', 'Feed OK / Print clear'),
      ] },
      { part: 'Part B: System Diagnostics & Hardware', title: 'Fluidics & Pump System', items: [
        ex('Peristaltic Pump Tubing', 'Intact / Good elasticity'),
        ex('Aspiration Mechanism', 'Smooth / No abnormal noise'),
        ex('Flow Cell Wash Cycle', 'Aspirates & drains properly'),
        ex('Waste Line & Waste Bottle', 'No blocks / Sensor working'),
      ] },
      { title: 'Mechanical & Incubation', items: [
        ex('Aspiration Push-Button / Switch', 'Triggers correctly'),
        ex('Incubation Temp (Machine Display)', 'Stabilizes at setpoint (e.g. 37°C)'),
        ex('Cooling Fan Operation', 'Airflow clear / Running smoothly'),
      ] },
      { title: 'Optical System & Flow Cell', items: [
        ex('Halogen Lamp Voltage (Multimeter / SW)', 'Within OEM spec'),
        ex('Flow Cell Cleanliness', 'No bubbles / Flushed clear'),
        ex('Photometer / Water Blank (Onboard SW)', 'AD Values within limits'),
        ex('Filter Wheel Mechanism', 'Smooth rotation / No errors'),
      ] },
      { part: 'Part C: Software & Maintenance', title: 'System Software & QC', items: [
        ex('Error Logs & Diagnostics', 'Reviewed / Cleared'),
        ex('System Date & Time', 'Synchronized'),
        ex('Run Daily Quality Control (QC serum)', 'Values Within Target Limits'),
      ] },
      { title: 'Cleaning Routine', items: [
        ex('Flush Flow Cell with Wash Solution', 'Completed'),
        ex('Empty & Clean Waste Bottle', 'Completed'),
        ex('Clean Fan Filters / Vents & Exterior', 'Completed'),
      ] },
    ],
  },
  {
    code: 'ULS', name: 'Ultrasound', form: 'CHPL/SER/GB-PMS-ULS',
    sections: [
      { title: 'Power Supply Checks', items: [
        { label: 'Line Voltage (L-N)', fields: one('V'), options: N },
        { label: 'Neutral-Ground Voltage (N-G)', fields: one('V'), options: N },
        { label: 'Line-Ground Voltage (L-G)', fields: one('V'), options: N },
        { label: 'UPS Voltage (Output)', fields: one('V'), options: N },
      ] },
      { title: 'Device Functionality Test', items: [
        { label: 'B Mode Test', options: N },
        { label: 'Color Mode Test', options: NI },
        { label: 'M Mode Test', options: N },
        { label: 'PW Mode Test', options: NI },
        { label: 'CW Mode Test', options: NI },
        { label: 'Control Panel Test', options: N },
        { label: 'Patient Data Management Test', options: N },
      ] },
      { title: 'Device Performance Test', items: [
        { label: 'Abdominal Probe Check', options: NI },
        { label: 'Linear Array Probe Check', options: NI },
        { label: 'Cardiac Probe Check', options: NI },
        { label: 'Endo-cavity Probe Check', options: NI },
        { label: '4D Probe Check', options: NI },
      ] },
      { title: 'Cleaning and Maintenance', items: [
        { label: 'Dust Filter Cleaning', options: CL },
        { label: 'Trackball Cleaning', options: CL },
        { label: 'Control Panel Cleaning', options: CL },
        { label: 'Monitor Cleaning', options: CL },
        { label: 'Device Body Cleaning', options: CL },
        { label: 'Probe Cleaning', options: CL },
      ] },
      { title: 'Remarks', items: [
        { label: 'Device operation environment', text: true },
        { label: 'Hardware condition (state of the hardware)', text: true },
        { label: 'Software (self-test result, software version)', text: true },
        { label: 'Probe condition (record the abnormal condition)', text: true },
      ] },
    ],
  },
  {
    code: 'VNT', name: 'Ventilator', form: 'CHPL/SER/GB-PMS-VNT',
    sections: [
      { title: 'Physical Inspection', items: [
        { label: 'Check the Power code and cables' },
        { label: 'Inspect the ventilator body and wheels' },
        { label: 'Clean Exterior' },
        { label: 'Clean and replace the air inlet filter' },
        { label: 'Line Voltage', fields: V3 },
        { label: 'Battery Health /Backup', fields: BATTERY },
        { label: 'Verify user interface (Touch screen, Physical switches/Nobes etc.)' },
        { label: 'Oxygen Inlet Pressure', fields: one('Bar/PSI') },
        { label: 'Air Inlet Pressure (IF Applicable)', fields: one('Bar/PSI') },
        { label: 'Ventilator usage Duration', fields: one('Hr') },
        { label: 'Perform Self-Test' },
        { label: 'Alarm Verification' },
      ] },
      { title: 'Performance Test value', items: [
        { label: 'Tidal Volume Accuracy', fields: SM('L') },
        { label: 'PEEP', fields: SM('cm/H2O') },
        { label: 'PIP', fields: SM('cm/H2O') },
        { label: 'RR', fields: SM('BPM') },
        { label: 'FiO2 at 21%', fields: M('%') },
        { label: 'FiO2 at 100%', fields: M('%') },
      ] },
    ],
  },
  {
    code: 'XRDR', name: 'X-Ray DR', form: 'CHPL/SER/GB-XRDR',
    sections: [
      { part: 'Part A: X-Ray Unit', title: 'Power Supply & Earthing', items: [
        ex('Mains Voltage L–N', '220–240 V ±5%'),
        ex('Mains Voltage L–L (3-Phase)', '380–415 V ±5%'),
        ex('Earth / Ground Resistance', '≤ 0.1 Ω'),
        ex('Neutral–Earth Voltage', '< 2 V AC'),
        ex('MCB / Fuse Rating', 'Visual / Functional Check'),
        ex('Phase Changeover Relay', 'Visual / Functional Check'),
      ] },
      { title: 'HT Cable & Connector', items: [
        ex('HT Cable Insulation (Core To Shield)', '≥ 100 MΩ'),
        ex('HT Cable Core Continuity', '< 1 Ω'),
        ex('Connector Gel/Oil – Anode (Visual)', 'Visual/Functional'),
        ex('Connector Gel/Oil – Cathode (Visual)', 'Visual/Functional'),
        ex('Locking Collar & Tracking', 'Visual/Functional'),
      ] },
      { title: 'X-Ray Tube & Rotor', items: [
        ex('Stator Winding Resistance – Main', '2–10 Ω (OEM Spec)'),
        ex('Stator Winding Resistance – Aux', '4–20 Ω (OEM Spec)'),
        ex('Rotor Voltage – Low (Start)', '100–120 V AC'),
        ex('Rotor Voltage – High (Run)', '180–220 V AC'),
        ex('Rotor Run-Up/Coast-Down Time', '< 1.5 S / < 60 S'),
        ex('Rotor Bearing Noise / Tube Visual', 'Visual/Functional'),
      ] },
      { title: 'kV Circuit (Feedback Test Points)', items: [
        ex('HF DC Bus Voltage', '290–340 V DC'),
        ex('kV Feedback (60/80/100/125 kV)', 'Per OEM Chart (mV)'),
        ex('Preheat Voltage (Small/Large Focus)', '6–9V / 8–11V DC'),
        ex('DC Bus Ripple', '< 4% Of DC Bus V'),
      ] },
      { title: 'mA / Exposure Circuit', items: [
        ex('mA Feedback (100/200/300/500 mA)', 'Per OEM Chart (mV)'),
        ex('Exposure Timer Logic Output', '0 V → 5 V'),
      ] },
      { title: 'Collimator & Alignment', items: [
        ex('Collimator Lamp Voltage', 'Voltage'),
        ex('Light/X-Ray Field & Crosshair Acc.', 'Physical / ±2 mm'),
      ] },
      { title: 'Mechanical', items: [
        ex('SID & Angulation Accuracy', '±5 mm / ±1°'),
        ex('Column Locks/Brakes & Bucky Tray', 'Visual/Functional'),
      ] },
      { title: 'Interlocks & Safety', items: [
        ex('Door Interlock V / Mag Switch Gap', '0→24V / ≤ 5 mm'),
        ex('E-Stop & Hand Switch Continuity', '0 Ω Pressed'),
        ex('Anti-Collision Sensor (If fitted)', 'Visual/Functional'),
      ] },
      { title: 'Console Power Rails & SW', items: [
        ex('Logic Supply +5 V', '5.0 V ±0.25 V'),
        ex('Analogue Supply +12V/+15V & -12V/-15V', '±5%'),
        ex('Relay Supply +24 V', '24 V ±5%'),
        ex('kV/mA Display Match & Fault Codes', 'Match ±10% / Check'),
      ] },
      { part: 'Part B: Digital Radiography (DR) Panel', title: 'Physical Inspection', items: [
        ex('Detector Casing & Surface', 'Intact / No Marks'),
        ex('Locking Mech / Battery Compartment', 'Functional / Clean'),
        ex('Handle Grips / Panel Labels', 'Intact / Visible'),
      ] },
      { title: 'Battery And Power System', items: [
        ex('Battery Condition & Charging', 'Good / Normal'),
        ex('Charge Retention & Spare Batteries', 'Verified / Available'),
        ex('Power Indicators & Charger', 'Functional / No Damage'),
      ] },
      { title: 'Communication & Connectivity', items: [
        ex('Wireless/Wired Comms & IP Settings', 'Verified'),
        ex('Signal Strength & Transfer Speed', 'Adequate / Normal'),
        ex('Sync With Generator / Workstation Rec.', 'Verified / Yes'),
      ] },
      { title: 'Functional Testing', items: [
        ex('Startup Test & Calibration Status', 'Completed / Checked'),
        ex('Exposure Readiness & Test Acquisitions', 'Verified / Success'),
        ex('Image Artifacts / Auto-Trigger', 'None / Functional'),
      ] },
      { title: 'Image Quality Evaluation', items: [
        ex('Uniformity Test & Dead Pixels', 'Performed / None'),
        ex('Line Artifacts & Image Lag', 'None Detected'),
        ex('Contrast, Resolution & Noise', 'Acceptable'),
      ] },
      { title: 'Software & System Verification', items: [
        ex('Software/Firmware Versions', 'Verified'),
        ex('Acquisition SW & Error Logs', 'Functional / Reviewed'),
        ex('System Time & Backup Config', "Sync'd / Verified"),
      ] },
      { title: 'Cleaning & Maintenance', items: [
        ex('Detector Surface & Contacts', 'Cleaned'),
        ex('Charger, Workstation & Storage Area', 'Cleaned/Inspected'),
      ] },
      { title: 'Safety Checks', items: [
        ex('Grounding & Overheating', 'Verified / None'),
        ex('Safety Labels & Accessories', 'Legible / No Damage'),
        ex('Abnormal Alarms or Warnings', 'None'),
      ] },
    ],
  },
  {
    code: 'XRM', name: 'X-Ray Machine', form: 'CHPL/SER/GB-PMS-XRM',
    sections: [
      { title: 'Power Supply & Earthing', items: [
        ex('Mains Voltage L–N', '220–240 V ±5%'),
        ex('Mains Voltage L–L (3-phase)', '380–415 V ±5%'),
        ex('Earth / Ground Resistance', '≤ 0.1 Ω'),
        ex('Neutral–Earth Voltage', '< 2 V AC'),
        ex('MCB / Fuse Rating', 'Visual / Functional Check'),
        ex('Phase Changeover Relay', 'Visual / Functional Check'),
      ] },
      { title: 'HT Cable & Connector', items: [
        ex('HT Cable Insulation (Core to Shield)', '≥ 100 MΩ'),
        ex('HT Cable Core Continuity', '< 1 Ω'),
        ex('Connector Gel/Oil – Anode (Visual)', 'Visual / Functional Check'),
        ex('Connector Gel/Oil – Cathode (Visual)', 'Visual / Functional Check'),
        ex('Locking Collar & Tracking', 'Visual / Functional Check'),
      ] },
      { title: 'X-Ray Tube & Rotor', items: [
        ex('Stator Winding Resistance – Main', '2–10 Ω (OEM spec)'),
        ex('Stator Winding Resistance – Aux', '4–20 Ω (OEM spec)'),
        ex('Rotor Voltage – Low (Start)', '100–120 V AC'),
        ex('Rotor Voltage – High (Run)', '180–220 V AC'),
        ex('Rotor Run-up Time', '< 1.5 s'),
        ex('Rotor Coast-down Time', '< 60 s'),
        ex('Rotor Bearing Noise (Audible)', 'Visual / Functional Check'),
        ex('Tube Visual – Copper Deposit / Cracks', 'Visual / Functional Check'),
      ] },
      { title: 'kV Circuit (Feedback Test Points)', items: [
        ex('HF DC Bus Voltage', '290–340 V DC'),
        ex('kV Feedback – 60 kV', 'Per OEM chart (mV)'),
        ex('kV Feedback – 80 kV', 'Per OEM chart (mV)'),
        ex('kV Feedback – 100 kV', 'Per OEM chart (mV)'),
        ex('kV Feedback – 125 kV', 'Per OEM chart (mV)'),
        ex('Preheat Voltage – Small Focus', '6–9 V DC'),
        ex('Preheat Voltage – Large Focus', '8–11 V DC'),
        ex('DC Bus Ripple', '< 4% of DC Bus V'),
      ] },
      { title: 'mA / Exposure Circuit', items: [
        ex('mA Feedback – 100 mA', 'Per OEM chart (mV)'),
        ex('mA Feedback – 200 mA', 'Per OEM chart (mV)'),
        ex('mA Feedback – 300 mA', 'Per OEM chart (mV)'),
        ex('mA Feedback – 500 mA', 'Per OEM chart (mV)'),
        ex('Exposure Timer Logic Output', '0 V → 5 V on exposure'),
      ] },
      { title: 'Collimator & Alignment', items: [
        ex('Collimator Lamp Voltage', 'Voltage'),
        ex('Light / X-ray Field Coincidence', 'Physical/Visual'),
        ex('Cross-hair & Field Size Accuracy', '±2 mm; ±2% of SID'),
      ] },
      { title: 'Mechanical', items: [
        ex('SID Indicator Accuracy', '±5 mm'),
        ex('Angulation Scale Accuracy', '±1°'),
        ex('Column Locks / Brakes', 'Visual / Functional Check'),
        ex('Bucky Tray & Fasteners', 'Visual / Functional Check'),
      ] },
      { title: 'Interlocks & Safety Switches', items: [
        ex('Door Interlock Voltage', '0 V open → 24 V closed'),
        ex('Door Magnetic Switch Gap', '≤ 5 mm'),
        ex('E-Stop Continuity', '0 Ω pressed; OL released'),
        ex('Hand Switch – Stage 1 & 2 Continuity', '0 Ω each stage'),
        ex('Anti-Collision Sensor (if fitted)', 'Visual / Functional Check'),
      ] },
      { title: 'Console Power Rails & Software', items: [
        ex('Logic Supply +5 V', '5.0 V ±0.25 V'),
        ex('Analogue Supply +12 V / +15 V', '+12 V or +15 V ±5%'),
        ex('Analogue Supply –12 V / –15 V', '–12 V or –15 V ±5%'),
        ex('Relay Supply +24 V', '24 V ±5%'),
        ex('kV / mA Display vs Test Point', 'Match ±10%'),
        ex('Active Fault Codes (Service Menu)', 'Visual / Functional Check'),
      ] },
    ],
  },
];

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Each row gets an id from its wording, unique within its checklist, and its choices. */
export const CHECKLISTS = RAW.map((c) => {
  const seen = new Map();
  return {
    ...c,
    sections: c.sections.map((s) => ({
      ...s,
      items: s.items.map((it) => {
        const base = slug(it.label);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const kind = it.params ? 'params' : it.text ? 'text' : 'check';
        return { ...it, id: n > 1 ? `${base}-${n}` : base, kind, options: kind === 'check' ? (it.options ?? OK) : null };
      }),
    })),
  };
});

export const CHECKLIST = Object.fromEntries(CHECKLISTS.map((c) => [c.code, c]));

/** The rows a person presses, in order. */
export const checkRows = (c) => c.sections.flatMap((s) => s.items.filter((it) => it.kind === 'check'));
